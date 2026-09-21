/**
 * Codex session files (`~/.codex/sessions/**\/rollout-*.jsonl`).
 *
 * Record shapes were taken from real files on the workstation, not from
 * documentation — Codex does not publish this format. Anything unrecognised
 * is skipped rather than guessed at, and a malformed line never fails a file.
 *
 * Observed:
 *   session_meta                      { id, timestamp, cwd, cli_version, … }
 *   turn_context                      { model, cwd, … }
 *   response_item / message           { role: user|assistant|developer, content: [{ type, text }] }
 *   response_item / reasoning         { summary: [], encrypted_content } — not readable, never decoded
 *   response_item / custom_tool_call  { name, input }
 *   response_item / function_call     { name, arguments }
 *   response_item / *_call_output     { output: [{ type, text }] | string }
 *   event_msg / token_count           { info.total_token_usage, rate_limits }
 *   event_msg / turn_aborted
 */
import {
  HISTORY_LIMITS,
  type ExternalConversationSummary,
  type HistoryItem,
  type ProviderUsageSnapshot,
  type TokenTotals,
  type UsageWindow,
} from '@odysseus/protocol';

import { UUID_PATTERN, prepareText, toIso, toTitle } from './text';

interface Line {
  type?: string;
  timestamp?: string;
  payload?: Record<string, unknown> & { type?: string };
}

function parse(line: string): Line | null {
  try {
    const value = JSON.parse(line) as unknown;
    return value && typeof value === 'object' ? (value as Line) : null;
  } catch {
    return null;
  }
}

/**
 * Codex wraps context it adds itself in tags and sends it as a "user"
 * message. Those are not things the person typed, so they are never used as a
 * title or shown as the user's words.
 */
const INJECTED = /^\s*<([a-z_]+)>[\s\S]*<\/\1>\s*$/;

function messageText(payload: Record<string, unknown>): string {
  const content = payload['content'];
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content
    .map((part) => (part && typeof part === 'object' ? (part as { text?: unknown }).text : ''))
    .filter((text): text is string => typeof text === 'string' && text.length > 0)
    .join('\n');
}

function outputText(payload: Record<string, unknown>): string {
  const output = payload['output'];
  if (typeof output === 'string') return output;
  if (Array.isArray(output)) {
    return (output as unknown[])
      .map((part: unknown) =>
        part && typeof part === 'object' ? (part as { text?: unknown }).text : part,
      )
      .filter((text): text is string => typeof text === 'string')
      .join('\n');
  }
  return output == null ? '' : JSON.stringify(output);
}

function num(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : 0;
}

function tokenTotals(usage: unknown): TokenTotals | undefined {
  if (!usage || typeof usage !== 'object') return undefined;
  const u = usage as Record<string, unknown>;
  if (typeof u['total_tokens'] !== 'number') return undefined;
  return {
    input: num(u['input_tokens']),
    cachedInput: num(u['cached_input_tokens']),
    output: num(u['output_tokens']),
    reasoning: num(u['reasoning_output_tokens']),
    total: num(u['total_tokens']),
  };
}

export type CodexSummary = Omit<ExternalConversationSummary, 'integration' | 'workspace'> & {
  cwd?: string | undefined;
};

/**
 * Metadata for the conversation list. Tokens are only included when the
 * caller holds usage.read — history.read alone does not reveal usage.
 */
export function summariseCodex(
  lines: string[],
  options: { includeTokens: boolean; fallbackId?: string | undefined },
): CodexSummary | null {
  let externalId: string | undefined;
  let startedAt: string | undefined;
  let updatedAt: string | undefined;
  let cwd: string | undefined;
  let model: string | undefined;
  let title = '';
  let messageCount = 0;
  let toolCallCount = 0;
  let tokens: TokenTotals | undefined;

  for (const raw of lines) {
    const line = parse(raw);
    if (!line) continue;
    const at = toIso(line.timestamp);
    if (at) updatedAt = at;
    const payload = line.payload ?? {};

    if (line.type === 'session_meta') {
      if (typeof payload['id'] === 'string' && UUID_PATTERN.test(payload['id']))
        externalId = payload['id'];
      startedAt = toIso(payload['timestamp']) ?? at ?? startedAt;
      if (typeof payload['cwd'] === 'string') cwd = payload['cwd'];
    } else if (line.type === 'turn_context') {
      if (typeof payload['model'] === 'string') model = payload['model'];
      if (!cwd && typeof payload['cwd'] === 'string') cwd = payload['cwd'];
    } else if (line.type === 'response_item') {
      if (payload.type === 'message') {
        const role = payload['role'];
        const text = messageText(payload);
        if (role === 'user' && text && !INJECTED.test(text)) {
          messageCount += 1;
          if (!title) title = toTitle(text);
        } else if (role === 'assistant' && text) {
          messageCount += 1;
        }
      } else if (payload.type === 'custom_tool_call' || payload.type === 'function_call') {
        toolCallCount += 1;
      }
    } else if (
      line.type === 'event_msg' &&
      payload.type === 'token_count' &&
      options.includeTokens
    ) {
      const info = payload['info'] as Record<string, unknown> | undefined;
      tokens = tokenTotals(info?.['total_token_usage']) ?? tokens;
    }
  }

  externalId ??= options.fallbackId;
  if (!externalId || !UUID_PATTERN.test(externalId)) return null;
  const started = startedAt ?? updatedAt;
  if (!started) return null;

  return {
    externalId,
    title,
    startedAt: started,
    updatedAt: updatedAt ?? started,
    messageCount,
    toolCallCount,
    ...(model ? { model } : {}),
    ...(cwd ? { cwd } : {}),
    ...(tokens ? { tokens } : {}),
    hasTranscript: true,
  };
}

/** The conversation itself, for when the user chooses to sync its content. */
export function codexItems(lines: string[]): { items: HistoryItem[]; truncated: boolean } {
  const items: HistoryItem[] = [];
  const push = (item: Omit<HistoryItem, 'seq'>) => {
    items.push({ seq: items.length, ...item });
  };

  for (const raw of lines) {
    if (items.length >= HISTORY_LIMITS.itemsPerConversation) {
      return { items, truncated: true };
    }
    const line = parse(raw);
    if (!line) continue;
    const at = toIso(line.timestamp);
    const payload = line.payload ?? {};

    if (line.type === 'response_item') {
      if (payload.type === 'message') {
        const role = payload['role'];
        const text = messageText(payload);
        if (!text) continue;
        // Developer messages are Codex's own instructions, not the conversation.
        if (role === 'developer' || role === 'system') continue;
        if (role === 'user' && INJECTED.test(text)) continue;
        const prepared = prepareText(text);
        push({
          kind: role === 'user' ? 'user' : 'assistant',
          text: prepared.text,
          ...(prepared.truncated ? { truncated: true } : {}),
          ...(at ? { at } : {}),
        });
      } else if (payload.type === 'reasoning') {
        // The readable summary, when there is one. `encrypted_content` is
        // never decoded — it is not the user's to read either.
        const summary = payload['summary'];
        const text = Array.isArray(summary)
          ? summary
              .map((part) =>
                part && typeof part === 'object' ? (part as { text?: unknown }).text : '',
              )
              .filter((part): part is string => typeof part === 'string')
              .join('\n')
          : '';
        if (text) {
          const prepared = prepareText(text);
          push({
            kind: 'thinking',
            text: prepared.text,
            ...(prepared.truncated ? { truncated: true } : {}),
            ...(at ? { at } : {}),
          });
        }
      } else if (payload.type === 'custom_tool_call' || payload.type === 'function_call') {
        const name = typeof payload['name'] === 'string' ? payload['name'] : 'tool';
        const prepared = prepareText(payload['input'] ?? payload['arguments'] ?? '');
        push({
          kind: 'tool_call',
          toolName: name.slice(0, 80),
          text: prepared.text,
          ...(prepared.truncated ? { truncated: true } : {}),
          ...(at ? { at } : {}),
        });
      } else if (
        payload.type === 'custom_tool_call_output' ||
        payload.type === 'function_call_output'
      ) {
        const prepared = prepareText(outputText(payload));
        push({
          kind: 'tool_result',
          text: prepared.text,
          ...(prepared.truncated ? { truncated: true } : {}),
          ...(at ? { at } : {}),
        });
      }
    } else if (line.type === 'event_msg' && payload.type === 'turn_aborted') {
      push({ kind: 'system', text: 'Turn aborted', ...(at ? { at } : {}) });
    }
  }
  return { items, truncated: false };
}

/**
 * The most recent plan limits in these lines, exactly as Codex recorded them.
 * Returns null when no token_count carried rate limits — never a default.
 */
export function codexUsage(lines: string[]): ProviderUsageSnapshot | null {
  let latest: ProviderUsageSnapshot | null = null;

  for (const raw of lines) {
    const line = parse(raw);
    const payload = line?.payload;
    if (!line || line.type !== 'event_msg' || payload?.type !== 'token_count') continue;
    const limits = payload['rate_limits'] as Record<string, unknown> | undefined;
    if (!limits || typeof limits !== 'object') continue;

    const observedAt = toIso(line.timestamp);
    if (!observedAt) continue;

    const windows: UsageWindow[] = [];
    for (const name of ['primary', 'secondary'] as const) {
      const window = limits[name] as Record<string, unknown> | undefined;
      if (!window || typeof window !== 'object') continue;
      const used = window['used_percent'];
      const minutes = window['window_minutes'];
      const resetsAt = toIso(window['resets_at']);
      if (typeof used !== 'number' || typeof minutes !== 'number' || !resetsAt) continue;
      windows.push({ name, usedPercent: used, windowMinutes: minutes, resetsAt });
    }

    const credits = limits['credits'] as Record<string, unknown> | undefined;
    const snapshot: ProviderUsageSnapshot = {
      provider: 'codex',
      source: 'codex-rate-limits',
      observedAt,
      ...(typeof limits['plan_type'] === 'string' ? { planType: limits['plan_type'] } : {}),
      ...(windows.length ? { windows } : {}),
      ...(credits && typeof credits === 'object'
        ? {
            credits: {
              hasCredits: credits['has_credits'] === true,
              unlimited: credits['unlimited'] === true,
              ...(credits['balance'] != null ? { balance: String(credits['balance']) } : {}),
            },
          }
        : {}),
    };

    if (!latest || Date.parse(snapshot.observedAt) >= Date.parse(latest.observedAt))
      latest = snapshot;
  }
  return latest;
}
