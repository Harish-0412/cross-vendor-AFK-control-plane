import WebSocket, { WebSocketServer } from 'ws';
import { v4 as uuidv4 } from 'uuid';
import { GatewayMessage, MessageType, parseMessage, createMessage } from './protocol';

interface ClientSession {
  ws: WebSocket;
  deviceId: string;
  authenticated: boolean;
  sequence: number;
  lastAcked: number;
  pendingMessages: GatewayMessage[];
}

export class TestGatewayServer extends WebSocketServer {
  private clients: Map<string, ClientSession> = new Map();
  private messageLog: GatewayMessage[] = [];
  private maxLogSize = 10000;

  constructor(port: number = 8080) {
    super({ port });
    this.setupHandlers();
    console.log(`[TEST SERVER] Started on ws://localhost:${port}`);
  }

  private setupHandlers(): void {
    this.on('connection', (ws, req) => {
      const clientId = uuidv4();
      const session: ClientSession = {
        ws,
        deviceId: '',
        authenticated: false,
        sequence: 0,
        lastAcked: 0,
        pendingMessages: []
      };

      this.clients.set(clientId, session);
      console.log(`[TEST SERVER] Client connected: ${clientId}`);

      ws.on('message', (data) => this.handleMessage(clientId, data));
      ws.on('close', (code, reason) => this.handleClose(clientId, code, reason));
      ws.on('error', (error) => this.handleError(clientId, error));
    });
  }

  private handleMessage(clientId: string, data: WebSocket.Data): void {
    const session = this.clients.get(clientId);
    if (!session) return;

    const message = parseMessage(data);
    if (!message) {
      console.warn(`[TEST SERVER] Invalid message from ${clientId}`);
      return;
    }

    session.sequence = Math.max(session.sequence, message.sequence);
    this.logMessage(message);

    switch (message.type) {
      case 'auth':
        this.handleAuth(clientId, message);
        break;
      case 'event':
      case 'command':
        this.handleAppMessage(clientId, message);
        break;
      case 'ack':
        this.handleAck(clientId, message);
        break;
      case 'heartbeat':
        this.handleHeartbeat(clientId, message);
        break;
      case 'reconnect':
        this.handleReconnect(clientId, message);
        break;
      default:
        console.warn(`[TEST SERVER] Unknown message type: ${message.type}`);
    }
  }

  private handleAuth(clientId: string, message: GatewayMessage): void {
    const session = this.clients.get(clientId);
    if (!session) return;

    const { deviceId, token } = message.payload;
    
    if (token && token.startsWith('Bearer ')) {
      session.deviceId = deviceId;
      session.authenticated = true;
      
      const response = createMessage('auth_response', {
        success: true,
        sessionId: `sess_${uuidv4().slice(0, 8)}`,
        serverSequence: session.sequence
      }, ++session.sequence);
      
      this.send(clientId, response);
      console.log(`[TEST SERVER] Authenticated: ${deviceId}`);
    } else {
      const response = createMessage('auth_response', {
        success: false,
        error: 'Invalid token'
      }, ++session.sequence);
      
      this.send(clientId, response);
      session.ws.close(4001, 'Authentication failed');
    }
  }

  private handleAppMessage(clientId: string, message: GatewayMessage): void {
    const session = this.clients.get(clientId);
    if (!session || !session.authenticated) {
      this.sendError(clientId, 'Not authenticated');
      return;
    }

    const ack = createMessage('ack', {
      ackSequence: message.sequence,
      messageId: message.id
    }, ++session.sequence);
    
    this.send(clientId, ack);

    if (message.type === 'command') {
      this.handleCommand(clientId, message);
    } else {
      this.broadcastToOthers(clientId, message);
    }
  }

  private handleCommand(clientId: string, message: GatewayMessage): void {
    const { command, params } = message.payload;
    console.log(`[TEST SERVER] Command: ${command}`, params);

    const response = createMessage('event', {
      eventType: 'command.response',
      sessionId: params.sessionId,
      data: { command, result: 'ok', correlationId: message.correlationId }
    }, ++this.clients.get(clientId)!.sequence);
    
    this.send(clientId, response);
  }

  private handleAck(clientId: string, message: GatewayMessage): void {
    const session = this.clients.get(clientId);
    if (!session) return;

    const ackSequence = message.payload?.ackSequence;
    if (ackSequence) {
      session.lastAcked = Math.max(session.lastAcked, ackSequence);
    }
  }

  private handleHeartbeat(clientId: string, message: GatewayMessage): void {
    const session = this.clients.get(clientId);
    if (!session) return;

    const ack = createMessage('ack', {
      ackSequence: message.sequence,
      messageId: message.id
    }, ++session.sequence);
    
    this.send(clientId, ack);
  }

  private handleReconnect(clientId: string, message: GatewayMessage): void {
    const session = this.clients.get(clientId);
    if (!session) return;

    const { lastAckedSequence } = message.payload;
    session.lastAcked = lastAckedSequence;

    const missedMessages = this.messageLog.filter(m => m.sequence > lastAckedSequence);
    
    const replay = createMessage('replay', {
      fromSequence: lastAckedSequence + 1,
      toSequence: session.sequence,
      messages: missedMessages
    }, ++session.sequence);
    
    this.send(clientId, replay);
    console.log(`[TEST SERVER] Replay ${missedMessages.length} messages for ${session.deviceId}`);
  }

  private handleClose(clientId: string, code: number, reason: Buffer): void {
    const session = this.clients.get(clientId);
    if (session) {
      console.log(`[TEST SERVER] Client disconnected: ${clientId} (${code})`);
      this.clients.delete(clientId);
    }
  }

  private handleError(clientId: string, error: Error): void {
    console.error(`[TEST SERVER] Error for ${clientId}:`, error.message);
  }

  private send(clientId: string, message: GatewayMessage): void {
    const session = this.clients.get(clientId);
    if (session && session.ws.readyState === WebSocket.OPEN) {
      const data = JSON.stringify(message);
      session.ws.send(data);
    }
  }

  private sendError(clientId: string, error: string): void {
    const session = this.clients.get(clientId);
    if (session) {
      const msg = createMessage('event', { eventType: 'error', data: { error } }, ++session.sequence);
      this.send(clientId, msg);
    }
  }

  private broadcastToOthers(senderId: string, message: GatewayMessage): void {
    for (const [id, session] of this.clients) {
      if (id !== senderId && session.authenticated) {
        this.send(id, message);
      }
    }
  }

  private logMessage(message: GatewayMessage): void {
    this.messageLog.push(message);
    if (this.messageLog.length > this.maxLogSize) {
      this.messageLog.shift();
    }
  }

  getConnectedClients(): number {
    return this.clients.size;
  }

  getClientInfo(): Array<{ id: string; deviceId: string; authenticated: boolean }> {
    return Array.from(this.clients.entries()).map(([id, s]) => ({
      id,
      deviceId: s.deviceId,
      authenticated: s.authenticated
    }));
  }

  simulateNetworkDrop(clientId: string): void {
    const session = this.clients.get(clientId);
    if (session) {
      session.ws.terminate();
    }
  }

  broadcastEvent(eventType: string, data: any): void {
    const message = createMessage('event', { eventType, data }, 0);
    for (const session of this.clients.values()) {
      if (session.authenticated) {
        this.send(session.ws._socket?.remoteAddress || '', message);
      }
    }
  }
}

export function createTestServer(port?: number): TestGatewayServer {
  return new TestGatewayServer(port || 8080);
}