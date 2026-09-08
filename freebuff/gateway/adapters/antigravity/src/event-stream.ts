import type { EventEnvelope, EventStream, EventSubscriber } from '@freebuff/protocol';
export class AntigravityEventStream implements EventStream {
  closed = false; private readonly events: EventEnvelope[] = []; private readonly listeners = new Set<Partial<EventSubscriber>>(); private readonly waiting: Array<(result: IteratorResult<EventEnvelope>) => void> = [];
  publish(event: EventEnvelope): void { if (this.closed) return; this.events.push(event); for (const listener of this.listeners) if (!listener.filter || listener.filter(event)) listener.onEvent?.(event); this.waiting.shift()?.({ value: event, done: false }); }
  subscribe(listener: Partial<EventSubscriber>): void { this.listeners.add(listener); }
  unsubscribe(): void { this.closed = true; this.listeners.clear(); while (this.waiting.length) this.waiting.shift()?.({ value: undefined, done: true }); }
  [Symbol.asyncIterator](): AsyncIterator<EventEnvelope> { let index = 0; return { next: () => { if (index < this.events.length) return Promise.resolve({ value: this.events[index++]!, done: false }); if (this.closed) return Promise.resolve({ value: undefined, done: true }); return new Promise<IteratorResult<EventEnvelope>>((resolve) => this.waiting.push(resolve)); } }; }
}
