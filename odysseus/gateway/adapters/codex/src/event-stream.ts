import type { EventEnvelope, EventSubscriber, EventStream } from '@odysseus/protocol';

export class AdapterEventStream implements EventStream {
  private readonly listeners = new Set<Partial<EventSubscriber>>();
  private readonly buffered: EventEnvelope[] = [];
  /** Iterators parked on an empty buffer; each is woken to read the buffer again. */
  private readonly waiting: Array<() => void> = [];
  closed = false;

  publish(event: EventEnvelope): void {
    if (this.closed) return;
    this.buffered.push(event);
    for (const listener of this.listeners) {
      try {
        if (!listener.filter || listener.filter(event)) listener.onEvent?.(event);
      } catch (error) {
        listener.onError?.(error instanceof Error ? error : new Error(String(error)));
      }
    }
    this.wake();
  }

  subscribe(listener: Partial<EventSubscriber>): void {
    this.listeners.add(listener);
  }
  unsubscribe(): void {
    this.close();
  }
  close(): void {
    if (this.closed) return;
    this.closed = true;
    for (const listener of this.listeners) listener.onClose?.();
    this.wake();
    this.listeners.clear();
  }

  private wake(): void {
    while (this.waiting.length) this.waiting.shift()?.();
  }

  [Symbol.asyncIterator](): AsyncIterator<EventEnvelope> {
    // Every read goes through the index. Handing a parked iterator the new
    // event directly, as this used to, left the index behind, so the next
    // read returned the same event again: every event that arrived while the
    // consumer was waiting was delivered twice.
    let index = 0;
    const next = (): Promise<IteratorResult<EventEnvelope>> => {
      if (index < this.buffered.length)
        return Promise.resolve({ value: this.buffered[index++]!, done: false });
      if (this.closed) return Promise.resolve({ value: undefined, done: true });
      return new Promise<void>((resolve) => this.waiting.push(resolve)).then(next);
    };
    return { next };
  }
}
