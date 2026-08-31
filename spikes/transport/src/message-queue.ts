import { GatewayMessage, PendingAck } from './types';
import { EventEmitter } from 'events';

export interface MessageQueueOptions {
  maxSize: number;
  ackTimeout: number;
  maxRetries: number;
}

export class MessageQueue extends EventEmitter {
  private queue: GatewayMessage[] = [];
  private pendingAcks: Map<string, PendingAck> = new Map();
  private sequence = 0;
  private options: MessageQueueOptions;
  private processing = false;

  constructor(options: Partial<MessageQueueOptions> = {}) {
    super();
    this.options = {
      maxSize: options.maxSize || 10000,
      ackTimeout: options.ackTimeout || 10000,
      maxRetries: options.maxRetries || 3
    };
  }

  enqueue(message: Omit<GatewayMessage, 'id' | 'sequence' | 'timestamp'>): GatewayMessage {
    if (this.queue.length >= this.options.maxSize) {
      throw new Error('Message queue full');
    }

    this.sequence++;
    const fullMessage: GatewayMessage = {
      ...message,
      id: `msg_${Date.now()}_${Math.random().toString(36).slice(2, 11)}`,
      sequence: this.sequence,
      timestamp: Date.now()
    };

    this.queue.push(fullMessage);
    this.emit('enqueued', fullMessage);
    return fullMessage;
  }

  dequeue(): GatewayMessage | undefined {
    return this.queue.shift();
  }

  peek(): GatewayMessage | undefined {
    return this.queue[0];
  }

  size(): number {
    return this.queue.length;
  }

  isEmpty(): boolean {
    return this.queue.length === 0;
  }

  registerAck(message: GatewayMessage): Promise<any> {
    return new Promise((resolve, reject) => {
      const pending: PendingAck = {
        messageId: message.id,
        sequence: message.sequence,
        timestamp: Date.now(),
        resolve,
        reject,
        retries: 0
      };

      this.pendingAcks.set(message.id, pending);

      setTimeout(() => {
        const p = this.pendingAcks.get(message.id);
        if (p) {
          p.retries++;
          if (p.retries >= this.options.maxRetries) {
            this.pendingAcks.delete(message.id);
            p.reject(new Error(`Ack timeout after ${this.options.maxRetries} retries`));
            this.emit('ackTimeout', message);
          } else {
            this.emit('retry', message, p.retries);
          }
        }
      }, this.options.ackTimeout);
    });
  }

  handleAck(ackMessage: GatewayMessage): boolean {
    const ackSequence = ackMessage.payload?.ackSequence;
    const messageId = ackMessage.payload?.messageId;

    if (!ackSequence || !messageId) return false;

    const pending = this.pendingAcks.get(messageId);
    if (!pending) return false;

    if (pending.sequence !== ackSequence) {
      return false;
    }

    pending.resolve(ackMessage.payload);
    this.pendingAcks.delete(messageId);
    this.emit('acked', pending);
    return true;
  }

  getPendingAcks(): PendingAck[] {
    return Array.from(this.pendingAcks.values());
  }

  getPendingCount(): number {
    return this.pendingAcks.size;
  }

  clear(): void {
    for (const pending of this.pendingAcks.values()) {
      pending.reject(new Error('Queue cleared'));
    }
    this.pendingAcks.clear();
    this.queue = [];
  }

  getSequence(): number {
    return this.sequence;
  }

  setSequence(seq: number): void {
    this.sequence = seq;
  }

  getUnackedMessages(): GatewayMessage[] {
    const unacked: GatewayMessage[] = [];
    for (const pending of this.pendingAcks.values()) {
      const msg = this.queue.find(m => m.id === pending.messageId);
      if (msg) unacked.push(msg);
    }
    return unacked;
  }
}

export class PriorityMessageQueue extends MessageQueue {
  private highPriority: GatewayMessage[] = [];
  private normalPriority: GatewayMessage[] = [];
  private lowPriority: GatewayMessage[] = [];

  enqueue(message: Omit<GatewayMessage, 'id' | 'sequence' | 'timestamp'>, priority: 'high' | 'normal' | 'low' = 'normal'): GatewayMessage {
    this.sequence++;
    const fullMessage: GatewayMessage = {
      ...message,
      id: `msg_${Date.now()}_${Math.random().toString(36).slice(2, 11)}`,
      sequence: this.sequence,
      timestamp: Date.now()
    };

    switch (priority) {
      case 'high':
        this.highPriority.unshift(fullMessage);
        break;
      case 'low':
        this.lowPriority.push(fullMessage);
        break;
      default:
        this.normalPriority.push(fullMessage);
    }

    this.emit('enqueued', fullMessage);
    return fullMessage;
  }

  dequeue(): GatewayMessage | undefined {
    return this.highPriority.shift() || this.normalPriority.shift() || this.lowPriority.shift();
  }

  size(): number {
    return this.highPriority.length + this.normalPriority.length + this.lowPriority.length;
  }

  isEmpty(): boolean {
    return this.highPriority.length === 0 && this.normalPriority.length === 0 && this.lowPriority.length === 0;
  }

  clear(): void {
    super.clear();
    this.highPriority = [];
    this.normalPriority = [];
    this.lowPriority = [];
  }
}