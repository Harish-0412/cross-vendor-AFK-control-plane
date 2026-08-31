import { ConnectionState, ReconnectConfig, DEFAULT_RECONNECT_CONFIG, GatewayMessage } from './types';
import { EventEmitter } from 'events';

export interface ReconnectManagerOptions extends Partial<ReconnectConfig> {
  onReconnect: (lastAckedSequence: number) => Promise<GatewayMessage[]>;
  onStateChange: (state: ConnectionState) => void;
}

export class ReconnectManager extends EventEmitter {
  private state: ConnectionState = 'disconnected';
  private config: ReconnectConfig;
  private reconnectAttempts = 0;
  private lastAckedSequence = 0;
  private reconnectTimer: NodeJS.Timeout | null = null;
  private options: ReconnectManagerOptions;

  constructor(options: ReconnectManagerOptions) {
    super();
    this.options = options;
    this.config = {
      maxAttempts: options.maxAttempts || DEFAULT_RECONNECT_CONFIG.maxAttempts,
      baseDelay: options.baseDelay || DEFAULT_RECONNECT_CONFIG.baseDelay,
      maxDelay: options.maxDelay || DEFAULT_RECONNECT_CONFIG.maxDelay,
      jitter: options.jitter || DEFAULT_RECONNECT_CONFIG.jitter,
      backoffMultiplier: options.backoffMultiplier || DEFAULT_RECONNECT_CONFIG.backoffMultiplier
    };
  }

  getState(): ConnectionState {
    return this.state;
  }

  getReconnectAttempts(): number {
    return this.reconnectAttempts;
  }

  setLastAckedSequence(seq: number): void {
    this.lastAckedSequence = seq;
  }

  getLastAckedSequence(): number {
    return this.lastAckedSequence;
  }

  setState(newState: ConnectionState): void {
    if (this.state !== newState) {
      const oldState = this.state;
      this.state = newState;
      this.options.onStateChange(newState);
      this.emit('stateChange', { oldState, newState });
    }
  }

  async initiateReconnect(): Promise<GatewayMessage[]> {
    if (this.state === 'reconnecting' || this.state === 'connected') {
      return [];
    }

    this.setState('reconnecting');
    this.reconnectAttempts = 0;

    while (this.reconnectAttempts < this.config.maxAttempts) {
      try {
        this.emit('reconnectAttempt', this.reconnectAttempts + 1);
        
        const replayedMessages = await this.options.onReconnect(this.lastAckedSequence);
        
        this.reconnectAttempts = 0;
        this.setState('reconciling');
        
        this.emit('reconnected', replayedMessages);
        return replayedMessages;
      } catch (error) {
        this.reconnectAttempts++;
        this.emit('reconnectFailed', error, this.reconnectAttempts);
        
        if (this.reconnectAttempts >= this.config.maxAttempts) {
          this.setState('disconnected');
          this.emit('reconnectExhausted');
          throw new Error(`Reconnect failed after ${this.config.maxAttempts} attempts`);
        }

        const delay = this.calculateBackoff(this.reconnectAttempts);
        this.emit('reconnectDelay', delay);
        
        await this.sleep(delay);
      }
    }

    throw new Error('Reconnect loop exited unexpectedly');
  }

  private calculateBackoff(attempt: number): number {
    const delay = Math.min(
      this.config.baseDelay * Math.pow(this.config.backoffMultiplier, attempt - 1),
      this.config.maxDelay
    );
    
    const jitter = delay * this.config.jitter * Math.random();
    return Math.floor(delay + jitter);
  }

  private sleep(ms: number): Promise<void> {
    return new Promise(resolve => {
      this.reconnectTimer = setTimeout(resolve, ms);
    });
  }

  cancelReconnect(): void {
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    this.reconnectAttempts = 0;
  }

  handleDisconnect(): void {
    if (this.state === 'connected') {
      this.setState('disconnected');
    }
  }

  handleConnectionDegraded(): void {
    if (this.state === 'connected') {
      this.setState('degraded');
    }
  }

  handleConnectionRestored(): void {
    if (this.state === 'degraded' || this.state === 'reconnecting') {
      this.setState('connected');
      this.reconnectAttempts = 0;
    }
  }

  reset(): void {
    this.cancelReconnect();
    this.reconnectAttempts = 0;
    this.lastAckedSequence = 0;
    this.setState('disconnected');
  }
}

export function createReconnectManager(options: ReconnectManagerOptions): ReconnectManager {
  return new ReconnectManager(options);
}