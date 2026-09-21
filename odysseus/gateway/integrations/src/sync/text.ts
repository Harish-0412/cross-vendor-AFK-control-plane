/**
 * Everything that turns tool data into text for the Control Plane goes
 * through here: redaction first, then length limits.
 *
 * Redaction runs on the workstation, before anything is sent. People paste
 * API keys and tokens into chats; those become `[REDACTED_…]` here and never
 * exist anywhere else.
 */
import { HISTORY_LIMITS } from '@odysseus/protocol';
import { createRedactor } from '@odysseus/redaction';

const redactor = createRedactor();

export function redact(text: string): string {
  if (!text) return '';
  return redactor.redact(text).text;
}

/** Redact, then cut to `limit`, reporting whether anything was cut. */
export function prepareText(
  text: unknown,
  limit: number = HISTORY_LIMITS.itemTextChars,
): { text: string; truncated: boolean } {
  const raw = typeof text === 'string' ? text : text == null ? '' : JSON.stringify(text);
  const clean = redact(raw);
  if (clean.length <= limit) return { text: clean, truncated: false };
  return { text: `${clean.slice(0, limit)}…`, truncated: true };
}

/** A one-line title from a first message: redacted, whitespace collapsed, shortened. */
export function toTitle(text: string): string {
  const oneLine = redact(text).replace(/\s+/g, ' ').trim();
  if (oneLine.length <= HISTORY_LIMITS.titleChars) return oneLine;
  return `${oneLine.slice(0, HISTORY_LIMITS.titleChars - 1)}…`;
}

export function toIso(value: unknown): string | undefined {
  if (typeof value === 'number' && Number.isFinite(value)) {
    // Seconds or milliseconds since the epoch; both occur in these files.
    const ms = value < 1e12 ? value * 1000 : value;
    return new Date(ms).toISOString();
  }
  if (typeof value === 'string') {
    const parsed = Date.parse(value);
    if (!Number.isNaN(parsed)) return new Date(parsed).toISOString();
  }
  return undefined;
}

export const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
