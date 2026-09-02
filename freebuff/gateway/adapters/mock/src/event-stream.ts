import type { EventEnvelope, EventSubscriber } from '@freebuff/protocol';
import { generateEventId, EVENT_VERSION } from '@freebuff/protocol';

type Listener = Partial<EventSubscriber>;

export class MockEventStream implements AsyncIterable<EventEnvelope> {
  private listeners: Set<Listener> = new Set();
  private buffer: EventEnvelope[] = [];
  private closed = false;
  private drainQueue: Array<(event: EventEnvelope) => void> = [];
  private maxBufferSize: number;

  constructor(maxBufferSize = 10000) {
    this.maxBufferSize = maxBufferSize;
  }

  get isClosed(): boolean {
    return this.closed;
  }

  get bufferedCount(): number {
    return this.buffer.length;
  }

  publish(
    event: Omit<EventEnvelope, 'eventId' | 'eventVersion' | 'occurredAt'> & {
      eventId?: string;
      eventVersion?: number;
      occurredAt?: Date;
    },
  ): void {
    if (this.closed) {
      throw new Error('Cannot publish to closed event stream');
    }

    const envelope: EventEnvelope = {
      eventId: event.eventId ?? generateEventId(),
      eventVersion: event.eventVersion ?? EVENT_VERSION,
      occurredAt: event.occurredAt ?? new Date(),
      eventType: event.eventType,
      sessionId: event.sessionId,
      sequence: event.sequence,
      payload: event.payload,
      ...(event.deviceId !== undefined ? { deviceId: event.deviceId } : {}),
      ...(event.correlationId !== undefined ? { correlationId: event.correlationId } : {}),
      ...(event.parentEventId !== undefined ? { parentEventId: event.parentEventId } : {}),
    };

    if (this.buffer.length >= this.maxBufferSize) {
      this.buffer.shift();
    }
    this.buffer.push(envelope);

    for (const listener of this.listeners) {
      try {
        if (listener.filter && !listener.filter(envelope)) continue;
        listener.onEvent?.(envelope);
      } catch (err) {
        listener.onError?.(err instanceof Error ? err : new Error(String(err)));
      }
    }

    while (this.drainQueue.length > 0 && this.buffer.length > 0) {
      const resolve = this.drainQueue.shift()!;
      const next = this.buffer.shift()!;
      resolve(next);
    }
  }

  subscribe(listener: Listener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  getBufferedEvents(fromSequence = -1): EventEnvelope[] {
    return this.buffer.filter((e) => e.sequence > fromSequence);
  }

  replay(fromSequence = -1): void {
    const toReplay = this.getBufferedEvents(fromSequence);
    for (const event of toReplay) {
      for (const listener of this.listeners) {
        try {
          if (listener.filter && !listener.filter(event)) continue;
          listener.onEvent?.(event);
        } catch (err) {
          listener.onError?.(err instanceof Error ? err : new Error(String(err)));
        }
      }
    }
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    for (const listener of this.listeners) {
      listener.onClose?.();
    }
    while (this.drainQueue.length > 0) {
      this.drainQueue.shift();
    }
    this.listeners.clear();
  }

  unsubscribe(): void {
    this.close();
  }

  [Symbol.asyncIterator](): AsyncIterator<EventEnvelope> {
    const stream = this;
    let index = 0;

    return {
      async next(): Promise<IteratorResult<EventEnvelope>> {
        while (true) {
          // First, drain any buffered events by index
          if (index < stream.buffer.length) {
            const value = stream.buffer[index]!;
            index++;
            return { value, done: false };
          }
          if (stream.closed) {
            return { value: undefined, done: true };
          }
          // Wait for the next event via the drain queue
          const nextEvent = await new Promise<EventEnvelope>((resolve) => {
            stream.drainQueue.push(resolve);
          });
          // The drain queue resolved with the event directly — return it
          return { value: nextEvent, done: false };
        }
      },
      async return(): Promise<IteratorResult<EventEnvelope>> {
        return { value: undefined, done: true };
      },
    };
  }
}

export function createEventStream(maxBufferSize?: number): MockEventStream {
  return new MockEventStream(maxBufferSize);
}
