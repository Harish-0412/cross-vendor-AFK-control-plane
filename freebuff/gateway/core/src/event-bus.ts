import type { EventEnvelope, EventSubscriber, EventType } from '@freebuff/protocol';

type ListenerEntry = {
  subscriber: Partial<EventSubscriber>;
  sessionScope?: string;
};

export class EventBus {
  private globalListeners: Set<ListenerEntry> = new Set();
  private sessionListeners: Map<string, Set<ListenerEntry>> = new Map();
  private eventHistory: EventEnvelope[] = [];
  private maxHistorySize: number;
  private errorHandlers: Set<(error: Error) => void> = new Set();

  constructor(options: { maxHistorySize?: number } = {}) {
    this.maxHistorySize = options.maxHistorySize ?? 10000;
  }

  publish(event: EventEnvelope): void {
    if (this.eventHistory.length >= this.maxHistorySize) {
      this.eventHistory.shift();
    }
    this.eventHistory.push(event);

    this.dispatchToListeners(this.globalListeners, event);

    const sessionListeners = this.sessionListeners.get(event.sessionId);
    if (sessionListeners) {
      this.dispatchToListeners(sessionListeners, event);
    }
  }

  subscribeGlobal(subscriber: Partial<EventSubscriber>): () => void {
    const entry: ListenerEntry = { subscriber };
    this.globalListeners.add(entry);
    return () => this.globalListeners.delete(entry);
  }

  subscribeSession(sessionId: string, subscriber: Partial<EventSubscriber>): () => void {
    if (!this.sessionListeners.has(sessionId)) {
      this.sessionListeners.set(sessionId, new Set());
    }
    const listeners = this.sessionListeners.get(sessionId)!;
    const entry: ListenerEntry = { subscriber, sessionScope: sessionId };
    listeners.add(entry);
    return () => {
      listeners.delete(entry);
      if (listeners.size === 0) {
        this.sessionListeners.delete(sessionId);
      }
    };
  }

  subscribeTypes(
    types: EventType[],
    subscriber: Partial<EventSubscriber>,
  ): () => void {
    const filter = subscriber.filter;
    const wrapped: Partial<EventSubscriber> = {
      ...subscriber,
      filter: (event) => {
        if (!types.includes(event.eventType)) return false;
        return filter ? filter(event) : true;
      },
    };
    return this.subscribeGlobal(wrapped);
  }

  onError(handler: (error: Error) => void): () => void {
    this.errorHandlers.add(handler);
    return () => this.errorHandlers.delete(handler);
  }

  getHistory(sessionId?: string, limit?: number): EventEnvelope[] {
    let results = this.eventHistory;
    if (sessionId) {
      results = results.filter((e) => e.sessionId === sessionId);
    }
    if (limit !== undefined) {
      results = results.slice(-limit);
    }
    return [...results];
  }

  getHistorySince(sequence: number, sessionId?: string): EventEnvelope[] {
    return this.getHistory(sessionId).filter((e) => e.sequence > sequence);
  }

  replaySince(sequence: number, sessionId?: string): number {
    const events = this.getHistorySince(sequence, sessionId);
    for (const event of events) {
      const listeners = sessionId ? this.sessionListeners.get(sessionId) : this.globalListeners;
      if (listeners) {
        this.dispatchToListeners(listeners, event);
      }
    }
    return events.length;
  }

  clearHistory(sessionId?: string): void {
    if (sessionId) {
      this.eventHistory = this.eventHistory.filter((e) => e.sessionId !== sessionId);
    } else {
      this.eventHistory = [];
    }
  }

  clear(): void {
    this.globalListeners.clear();
    this.sessionListeners.clear();
    this.eventHistory = [];
    this.errorHandlers.clear();
  }

  getGlobalListenerCount(): number {
    return this.globalListeners.size;
  }

  getSessionListenerCount(sessionId: string): number {
    return this.sessionListeners.get(sessionId)?.size ?? 0;
  }

  private dispatchToListeners(listeners: Set<ListenerEntry>, event: EventEnvelope): void {
    for (const entry of listeners) {
      try {
        const sub = entry.subscriber;
        if (sub.filter && !sub.filter(event)) continue;
        sub.onEvent?.(event);
      } catch (err) {
        const error = err instanceof Error ? err : new Error(String(err));
        entry.subscriber.onError?.(error);
        for (const handler of this.errorHandlers) {
          try { handler(error); } catch { /* swallow */ }
        }
      }
    }
  }
}

export function createEventBus(options?: ConstructorParameters<typeof EventBus>[0]): EventBus {
  return new EventBus(options);
}
