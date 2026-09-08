import type { EventEnvelope, EventSubscriber, EventStream } from '@freebuff/protocol';

export class AdapterEventStream implements EventStream {
  private readonly listeners = new Set<Partial<EventSubscriber>>();
  private readonly buffered: EventEnvelope[] = [];
  private readonly waiting: Array<(result: IteratorResult<EventEnvelope>) => void> = [];
  closed = false;

  publish(event: EventEnvelope): void {
    if (this.closed) return;
    this.buffered.push(event);
    for (const listener of this.listeners) {
      try { if (!listener.filter || listener.filter(event)) listener.onEvent?.(event); } catch (error) { listener.onError?.(error instanceof Error ? error : new Error(String(error))); }
    }
    this.waiting.shift()?.({ value: event, done: false });
  }

  subscribe(listener: Partial<EventSubscriber>): void { this.listeners.add(listener); }
  unsubscribe(): void { this.close(); }
  close(): void {
    if (this.closed) return;
    this.closed = true;
    for (const listener of this.listeners) listener.onClose?.();
    while (this.waiting.length) this.waiting.shift()?.({ value: undefined, done: true });
    this.listeners.clear();
  }

  [Symbol.asyncIterator](): AsyncIterator<EventEnvelope> {
    let index = 0;
    return {
      next: () => {
        if (index < this.buffered.length) return Promise.resolve({ value: this.buffered[index++]!, done: false });
        if (this.closed) return Promise.resolve({ value: undefined, done: true });
        return new Promise<IteratorResult<EventEnvelope>>((resolve) => this.waiting.push(resolve));
      },
    };
  }
}
