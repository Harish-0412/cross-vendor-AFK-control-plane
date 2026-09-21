/**
 * Antigravity transcripts
 * (`~/.gemini/antigravity/brain/<conversation>/.system_generated/logs/transcript[_full].jsonl`).
 *
 * `transcript_full.jsonl` is preferred: `transcript.jsonl` cuts long content
 * and lists what it cut in `truncated_fields`. Observed record fields:
 *   { step_index, type, created_at, status, source, content?, thinking?,
 *     tool_calls?: [{ name, args }], error?, truncated_fields? }
 * with type USER_INPUT | PLANNER_RESPONSE | GENERIC | SYSTEM_MESSAGE | ERROR_MESSAGE | CHECKPOINT.
 *
 * GENERIC is the tool result: verified against a real transcript, where every
 * PLANNER_RESPONSE carrying tool_calls is followed by one GENERIC with content.
 */
import {
  HISTORY_LIMITS,
  type ExternalConversationSummary,
  type HistoryItem,
} from '@odysseus/protocol';

import { prepareText, toIso, toTitle } from './text';

interface Step {
  step_index?: number;
  type?: string;
  created_at?: string;
  content?: unknown;
  thinking?: unknown;
  tool_calls?: Array<{ name?: unknown; args?: unknown }>;
  error?: unknown;
  truncated_fields?: string[];
}

function parse(line: string): Step | null {
  try {
    const value = JSON.parse(line) as unknown;
    return value && typeof value === 'object' ? (value as Step) : null;
  } catch {
    return null;
  }
}

const asText = (value: unknown): string =>
  typeof value === 'string' ? value : value == null ? '' : JSON.stringify(value);

export function summariseAntigravity(
  lines: string[],
  externalId: string,
): Omit<ExternalConversationSummary, 'integration'> | null {
  let title = '';
  let startedAt: string | undefined;
  let updatedAt: string | undefined;
  let messageCount = 0;
  let toolCallCount = 0;

  for (const raw of lines) {
    const step = parse(raw);
    if (!step) continue;
    const at = toIso(step.created_at);
    if (at) {
      startedAt ??= at;
      updatedAt = at;
    }
    const content = asText(step.content);
    if (step.type === 'USER_INPUT' && content) {
      messageCount += 1;
      if (!title) title = toTitle(content);
    } else if (step.type === 'PLANNER_RESPONSE' && content) {
      messageCount += 1;
    }
    toolCallCount += Array.isArray(step.tool_calls) ? step.tool_calls.length : 0;
  }

  if (!startedAt) return null;
  return {
    externalId,
    title,
    startedAt,
    updatedAt: updatedAt ?? startedAt,
    messageCount,
    toolCallCount,
    hasTranscript: true,
  };
}

export function antigravityItems(lines: string[]): { items: HistoryItem[]; truncated: boolean } {
  const items: HistoryItem[] = [];
  // The transcript itself may have shortened content; that is reported per
  // item so the UI can say so, separately from our own length limit.
  const push = (item: Omit<HistoryItem, 'seq'>, sourceTruncated: boolean) => {
    const { truncated, ...rest } = item;
    items.push({
      seq: items.length,
      ...rest,
      ...(sourceTruncated || truncated ? { truncated: true } : {}),
    });
  };

  for (const raw of lines) {
    if (items.length >= HISTORY_LIMITS.itemsPerConversation) return { items, truncated: true };
    const step = parse(raw);
    if (!step) continue;
    const at = toIso(step.created_at);
    const when = at ? { at } : {};
    const cut = Array.isArray(step.truncated_fields) && step.truncated_fields.includes('content');

    const content = asText(step.content);
    switch (step.type) {
      case 'USER_INPUT':
        if (content) push({ kind: 'user', ...prepareText(content), ...when }, cut);
        break;
      case 'PLANNER_RESPONSE':
        if (typeof step.thinking === 'string' && step.thinking) {
          push({ kind: 'thinking', ...prepareText(step.thinking), ...when }, false);
        }
        if (content) push({ kind: 'assistant', ...prepareText(content), ...when }, cut);
        break;
      case 'GENERIC':
        // GENERIC steps carry tool results; the calls themselves are below.
        if (content) push({ kind: 'tool_result', ...prepareText(content), ...when }, cut);
        break;
      case 'SYSTEM_MESSAGE':
      case 'CHECKPOINT':
        if (content) push({ kind: 'system', ...prepareText(content), ...when }, cut);
        break;
      case 'ERROR_MESSAGE':
        push(
          { kind: 'error', ...prepareText(asText(step.error) || content || 'Error'), ...when },
          false,
        );
        break;
      default:
        break;
    }

    for (const call of Array.isArray(step.tool_calls) ? step.tool_calls : []) {
      const name = typeof call?.name === 'string' ? call.name.slice(0, 80) : 'tool';
      push({ kind: 'tool_call', toolName: name, ...prepareText(call?.args ?? ''), ...when }, false);
    }
  }
  return { items, truncated: false };
}
