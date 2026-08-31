import WebSocket from 'ws';
import { EventEmitter } from 'events';
import { v4 as uuidv4 } from 'uuid';
import {
  ConnectionConfig,
  ConnectionState,
  GatewayMessage,
  DEFAULT_RECONNECT_CONFIG,
  DEFAULT_HEARTBEAT_CONFIG,
  MessageType
} from './types';
import { MessageQueue } from './message-queue';
import { ReconnectManager } from './reconnect';
import { parseMessage, createMessage, MessageSerializer } from './protocol';

export interface GatewayClientOptions extends ConnectionConfig {
  onMessage?: (message: GatewayMessage) => void;
  onStateChange?: (state: ConnectionState) => void;
  onError?: (error: Error) => void;
}

export class GatewayClient extends EventEmitter {
  private ws: WebSocket | null = null;
  private config: ConnectionConfig;
  private messageQueue: MessageQueue;
  private reconnectManager: ReconnectManager;
  private heartbeatTimer: NodeJS.Timeout | null = null;
  private missedHeartbeats = 0;
  private connectionId = '';
  private serverSequence = 0;
  private lastSequenceSent = 0;
  private lastSequenceAcked = 0;
  private isShuttingDown = false;

  constructor(options: GatewayClientOptions) {
    super();
    this.config = {
      reconnect: { ...DEFAULT_RECONNECT_CONFIG, ...options.reconnect },
      heartbeat: { ...DEFAULT_HEARTBEAT_CONFIG, ...options.heartbeat },
      tls: options.tls,
      ...options
    };

    this.messageQueue = new MessageQueue({
      maxSize: 10000,
      ackTimeout: 10000,
      maxRetries: 3
    });

    this.reconnectManager = new ReconnectManager({
      ...this.config.reconnect,
      onReconnect: this.handleReconnect.bind(this),
      onStateChange: (state) => this.handleStateChange(state)
    });

    this.setupMessageQueueHandlers();
  }

  private setupMessageQueueHandlers(): void {
    this.messageQueue.on('ackTimeout', (message) => {
      this.emit('ackTimeout', message);
    });

    this.messageQueue.on('retry', (message, retries) => {
      this.emit('retry', message, retries);
      this.sendMessage(message);
    });
  }

  async connect(): Promise<void> {
    if (this.ws?.readyState === WebSocket.OPEN) {
      return;
    }

    this.isShuttingDown = false;
    this.reconnectManager.setState('connecting');

    return new Promise((resolve, reject) => {
      try {
        this.ws = new WebSocket(this.config.url);

        this.ws.on('open', () => {
          this.connectionId = uuidv4();
          this.lastSequenceSent = 0;
          this.lastSequenceAcked = 0;
          this.serverSequence = 0;
          this.missedHeartbeats = 0;
          
          this.startHeartbeat();
          this.authenticate();
        });

        this.ws.on('message', (data) => {
          this.handleMessage(data);
        });

        this.ws.on('close', (code, reason) => {
          this.handleClose(code, reason.toString());
        });

        this.ws.on('error', (error) => {
          this.handleError(error);
          if (this.reconnectManager.getState() === 'connecting') {
            reject(error);
          }
        });

        const timeout = setTimeout(() => {
          if (this.ws?.readyState !== WebSocket.OPEN) {
            this.ws?.terminate();
            reject(new Error('Connection timeout'));
          }
        }, 10000);

        this.ws.once('open', () => clearTimeout(timeout));

      } catch (error) {
        reject(error);
      }
    });
  }

  private authenticate(): void {
    const authMsg = createMessage('auth', {
      deviceId: this.config.deviceId,
      token: this.config.authToken,
      capabilities: ['reconnect', 'replay', 'ack', 'heartbeat']
    }, ++this.lastSequenceSent);

    this.sendMessage(authMsg);
  }

  private handleMessage(data: WebSocket.Data): void {
    const message = parseMessage(data);
    if (!message) {
      this.emit('parseError', data);
      return;
    }

    this.serverSequence = Math.max(this.serverSequence, message.sequence);

    switch (message.type) {
      case 'ack':
        this.handleAck(message);
        break;
      case 'auth_response':
        this.handleAuthResponse(message);
        break;
      case 'heartbeat':
        this.handleHeartbeat(message);
        break;
      case 'replay':
        this.handleReplay(message);
        break;
      case 'event':
      case 'command':
        this.handleAppMessage(message);
        break;
      default:
        this.emit('unknownMessage', message);
    }
  }

  private handleAck(message: GatewayMessage): void {
    const ackSequence = message.payload?.ackSequence;
    const messageId = message.payload?.messageId;

    if (ackSequence && messageId) {
      this.lastSequenceAcked = Math.max(this.lastSequenceAcked, ackSequence);
      this.messageQueue.handleAck(message);
    }
  }

  private handleAuthResponse(message: GatewayMessage): void {
    if (message.payload?.success) {
      this.serverSequence = message.payload?.serverSequence || 0;
      this.reconnectManager.setState('connected');
      this.reconnectManager.setLastAckedSequence(this.lastSequenceAcked);
      this.emit('authenticated', message.payload);
    } else {
      this.emit('authFailed', message.payload?.error);
      this.disconnect();
    }
  }

  private handleHeartbeat(message: GatewayMessage): void {
    this.missedHeartbeats = 0;
    
    const ackMsg = createMessage('ack', {
      ackSequence: message.sequence,
      messageId: message.id
    }, ++this.lastSequenceSent);
    
    this.sendRaw(ackMsg);
  }

  private handleReplay(message: GatewayMessage): void {
    const replayedMessages = message.payload?.messages || [];
    for (const replayed of replayedMessages) {
      this.serverSequence = Math.max(this.serverSequence, replayed.sequence);
      this.handleAppMessage(replayed);
    }
    
    const ackMsg = createMessage('ack', {
      ackSequence: message.sequence,
      messageId: message.id
    }, ++this.lastSequenceSent);
    
    this.sendRaw(ackMsg);
  }

  private handleAppMessage(message: GatewayMessage): void {
    this.emit('message', message);
    
    const ackMsg = createMessage('ack', {
      ackSequence: message.sequence,
      messageId: message.id
    }, ++this.lastSequenceSent);
    
    this.sendRaw(ackMsg);
  }

  private async handleReconnect(lastAckedSequence: number): Promise<GatewayMessage[]> {
    const reconnectMsg = createMessage('reconnect', {
      deviceId: this.config.deviceId,
      lastAckedSequence,
      clientId: this.connectionId
    }, ++this.lastSequenceSent);

    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error('Reconnect timeout')), 10000);
      
      const handleReplay = (msg: GatewayMessage) => {
        if (msg.type === 'replay') {
          clearTimeout(timeout);
          this.off('message', handleReplay);
          resolve(msg.payload?.messages || []);
        }
      };

      this.on('message', handleReplay);
      this.sendRaw(reconnectMsg);
    });
  }

  private handleClose(code: number, reason: string): void {
    this.stopHeartbeat();
    
    if (this.isShuttingDown) {
      this.reconnectManager.setState('disconnected');
      this.emit('disconnected', { code, reason, clean: true });
      return;
    }

    this.reconnectManager.handleDisconnect();
    this.emit('disconnected', { code, reason, clean: code === 1000 });
    
    this.scheduleReconnect();
  }

  private handleError(error: Error): void {
    this.emit('error', error);
    this.config.onError?.(error);
  }

  private handleStateChange(state: ConnectionState): void {
    this.emit('stateChange', state);
    this.config.onStateChange?.(state);
  }

  private scheduleReconnect(): void {
    this.reconnectManager.initiateReconnect()
      .then(messages => {
        this.emit('reconnected', messages);
      })
      .catch(error => {
        this.emit('reconnectFailed', error);
      });
  }

  private startHeartbeat(): void {
    this.heartbeatTimer = setInterval(() => {
      if (this.ws?.readyState === WebSocket.OPEN) {
        this.missedHeartbeats++;
        
        if (this.missedHeartbeats >= this.config.heartbeat!.maxMissed) {
          this.ws.terminate();
          return;
        }

        const hbMsg = createMessage('heartbeat', { timestamp: Date.now() }, ++this.lastSequenceSent);
        this.sendRaw(hbMsg);
      }
    }, this.config.heartbeat!.interval);
  }

  private stopHeartbeat(): void {
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = null;
    }
  }

  async sendEvent(eventType: string, sessionId: string, data: any): Promise<void> {
    const message = createMessage('event', { eventType, sessionId, data }, ++this.lastSequenceSent);
    return this.sendWithAck(message);
  }

  async sendCommand(command: string, params: any): Promise<any> {
    const correlationId = `cmd_${Date.now()}_${Math.random().toString(36).slice(2, 9)}`;
    const message = createMessage('command', { command, params }, ++this.lastSequenceSent, correlationId);
    return this.sendWithAck(message);
  }

  private async sendWithAck(message: GatewayMessage): Promise<any> {
    const ackPromise = this.messageQueue.registerAck(message);
    this.sendMessage(message);
    return ackPromise;
  }

  private sendMessage(message: GatewayMessage): void {
    this.messageQueue.enqueue(message);
    this.flushQueue();
  }

  private sendRaw(message: GatewayMessage): void {
    if (this.ws?.readyState === WebSocket.OPEN) {
      const data = MessageSerializer.serialize(message);
      this.ws.send(data);
    }
  }

  private flushQueue(): void {
    while (!this.messageQueue.isEmpty()) {
      const message = this.messageQueue.dequeue();
      if (message) {
        this.sendRaw(message);
      }
    }
  }

  async disconnect(): Promise<void> {
    this.isShuttingDown = true;
    this.stopHeartbeat();
    this.reconnectManager.cancelReconnect();
    
    if (this.ws?.readyState === WebSocket.OPEN) {
      this.ws.close(1000, 'Client disconnect');
    }
    
    this.messageQueue.clear();
    this.reconnectManager.reset();
  }

  getState(): ConnectionState {
    return this.reconnectManager.getState();
  }

  getConnectionId(): string {
    return this.connectionId;
  }

  getQueueDepth(): number {
    return this.messageQueue.size();
  }

  getPendingAckCount(): number {
    return this.messageQueue.getPendingCount();
  }
}

export function createGatewayClient(options: GatewayClientOptions): GatewayClient {
  return new GatewayClient(options);
}