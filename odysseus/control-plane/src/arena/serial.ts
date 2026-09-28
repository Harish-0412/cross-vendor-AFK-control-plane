/** Run changes to one record one at a time; the caller still sees its own failure. */
export class Serial {
  private readonly locks = new Map<string, Promise<unknown>>();

  run<T>(key: string, work: () => Promise<T>): Promise<T> {
    const previous = this.locks.get(key) ?? Promise.resolve();
    const next = previous.catch(() => undefined).then(work);
    this.locks.set(key, next);
    void next
      .catch(() => undefined)
      .finally(() => {
        if (this.locks.get(key) === next) this.locks.delete(key);
      });
    return next;
  }
}

/** The last fenced block of the given language in `text`, parsed as JSON. */
export function lastJsonBlock(text: string, language: string): Record<string, unknown> | null {
  const pattern = new RegExp('```' + language + '\\s*\\n([\\s\\S]*?)```', 'g');
  const blocks = [...text.matchAll(pattern)];
  const body = blocks.at(-1)?.[1];
  if (!body) return null;
  try {
    const parsed: unknown = JSON.parse(body.trim());
    return parsed && typeof parsed === 'object' ? (parsed as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}
