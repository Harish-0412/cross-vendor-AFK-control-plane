import type { EventEnvelope, EventStream, EventSubscriber } from '@odysseus/protocol';
export class AntigravityEventStream implements EventStream {
  closed = false;
  private readonly events: EventEnvelope[] = [];
  private readonly listeners = new Set<Partial<EventSubscriber>>();
  /** Iterators parked on an empty buffer; each is woken to read the buffer again. */
  private readonly waiting: Array<() => void> = [];
  publish(event: EventEnvelope): void {
    if (this.closed) return;
    this.events.push(event);
    for (const listener of this.listeners)
      if (!listener.filter || listener.filter(event)) listener.onEvent?.(event);
    this.wake();
  }
  subscribe(listener: Partial<EventSubscriber>): void {
    this.listeners.add(listener);
  }
  unsubscribe(): void {
    this.closed = true;
    this.listeners.clear();
    this.wake();
  }
  private wake(): void {
    while (this.waiting.length) this.waiting.shift()?.();
  }
  [Symbol.asyncIterator](): AsyncIterator<EventEnvelope> {
    // Every read goes through the index; handing a parked iterator the event
    // directly left the index behind and delivered that event twice.
    let index = 0;
    const next = (): Promise<IteratorResult<EventEnvelope>> => {
      if (index < this.events.length)
        return Promise.resolve({ value: this.events[index++]!, done: false });
      if (this.closed) return Promise.resolve({ value: undefined, done: true });
      return new Promise<void>((resolve) => this.waiting.push(resolve)).then(next);
    };
    return { next };
  }
}
