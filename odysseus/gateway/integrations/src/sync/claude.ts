/**
 * Claude Code session files (`~/.claude/projects/<project>/<session>.jsonl`).
 *
 * This parser is deliberately tolerant because the file is a local cache, not
 * a published API. It only consumes fields Claude Code records explicitly and
 * never tries to infer tokens, decrypt thinking, or follow paths found inside
 * a record. The caller has already opened the file through the signed grant
 * allowlist.
 */
import {
  HISTORY_LIMITS,
  type ExternalConversationSummary,
  type HistoryItem,
  type TokenTotals,
} from '@odysseus/protocol';

import { UUID_PATTERN, prepareText, toIso, toTitle } from './text';

interface ClaudeLine {
  type?: string;
  timestamp?: string;
  sessionId?: string;
  cwd?: string;
  isSidechain?: boolean;
  summary?: unknown;
  message?: {
    id?: string;
    role?: string;
    model?: string;
    content?: unknown;
    usage?: Record<string, unknown>;
  };
}

interface ClaudePart {
  type?: string;
  text?: unknown;
  thinking?: unknown;
  name?: unknown;
  input?: unknown;
  content?: unknown;
  is_error?: unknown;
}

function parse(line: string): ClaudeLine | null {
  try {
    const value = JSON.parse(line) as unknown;
    return value && typeof value === 'object' ? (value as ClaudeLine) : null;
  } catch {
    return null;
  }
}

function parts(content: unknown): ClaudePart[] {
  if (typeof content === 'string') return [{ type: 'text', text: content }];
  return Array.isArray(content)
    ? content.filter((part): part is ClaudePart => Boolean(part) && typeof part === 'object')
    : [];
}

function visibleText(content: unknown): string {
  return parts(content)
    .filter((part) => part.type === 'text' && typeof part.text === 'string')
    .map((part) => String(part.text))
    .join('\n');
}

function number(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : 0;
}

function addUsage(total: TokenTotals, usage: Record<string, unknown>): void {
  total.input += number(usage['input_tokens']);
  total.cachedInput += number(usage['cache_read_input_tokens']);
  total.cacheWriteInput =
    (total.cacheWriteInput ?? 0) + number(usage['cache_creation_input_tokens']);
  total.output += number(usage['output_tokens']);
  total.reasoning += number(usage['reasoning_output_tokens']);
  total.total =
    total.input + total.cachedInput + (total.cacheWriteInput ?? 0) + total.output + total.reasoning;
}

export type ClaudeSummary = Omit<ExternalConversationSummary, 'integration' | 'workspace'> & {
  cwd?: string | undefined;
};

/** Metadata and exact recorded token totals for one Claude Code session. */
export function summariseClaude(
  lines: string[],
  options: { includeTokens: boolean; fallbackId?: string | undefined },
): ClaudeSummary | null {
  let externalId = options.fallbackId;
  let startedAt: string | undefined;
  let updatedAt: string | undefined;
  let cwd: string | undefined;
  let model: string | undefined;
  let title = '';
  let messageCount = 0;
  let toolCallCount = 0;
  const tokens: TokenTotals = {
    input: 0,
    cachedInput: 0,
    cacheWriteInput: 0,
    output: 0,
    reasoning: 0,
    total: 0,
  };
  const usageMessageIds = new Set<string>();
  let sawUsage = false;

  for (const raw of lines) {
    const line = parse(raw);
    if (!line || line.isSidechain === true) continue;
    const at = toIso(line.timestamp);
    if (at) {
      startedAt ??= at;
      updatedAt = at;
    }
    if (typeof line.sessionId === 'string' && UUID_PATTERN.test(line.sessionId)) {
      externalId = line.sessionId;
    }
    if (!cwd && typeof line.cwd === 'string') cwd = line.cwd;

    const message = line.message;
    if (!message) continue;
    if (typeof message.model === 'string') model = message.model;
    const text = visibleText(message.content);
    if (line.type === 'user' && message.role === 'user' && text) {
      messageCount += 1;
      if (!title) title = toTitle(text);
    } else if (line.type === 'assistant' && message.role === 'assistant') {
      if (text) messageCount += 1;
      toolCallCount += parts(message.content).filter((part) => part.type === 'tool_use').length;

      if (options.includeTokens && message.usage) {
        // Some Claude Code builds repeat the same assistant message while
        // updating it. Count a provider message id once, never once per line.
        const id = typeof message.id === 'string' ? message.id : `line:${usageMessageIds.size}`;
        if (!usageMessageIds.has(id)) {
          usageMessageIds.add(id);
          addUsage(tokens, message.usage);
          sawUsage = true;
        }
      }
    }
  }

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
    ...(sawUsage ? { tokens } : {}),
    hasTranscript: true,
  };
}

/** Renderable, redacted conversation items from a Claude Code session. */
export function claudeItems(lines: string[]): { items: HistoryItem[]; truncated: boolean } {
  const items: HistoryItem[] = [];
  const push = (item: Omit<HistoryItem, 'seq'>): boolean => {
    if (items.length >= HISTORY_LIMITS.itemsPerConversation) return false;
    items.push({ seq: items.length, ...item });
    return true;
  };

  for (const raw of lines) {
    const line = parse(raw);
    if (!line || line.isSidechain === true) continue;
    const at = toIso(line.timestamp);
    const when = at ? { at } : {};

    if (line.type === 'summary' && typeof line.summary === 'string') {
      if (!push({ kind: 'system', ...prepareText(line.summary), ...when })) {
        return { items, truncated: true };
      }
      continue;
    }

    const message = line.message;
    if (!message) continue;
    for (const part of parts(message.content)) {
      let item: Omit<HistoryItem, 'seq'> | null = null;
      if (part.type === 'text' && typeof part.text === 'string' && part.text) {
        item = {
          kind: message.role === 'user' ? 'user' : 'assistant',
          ...prepareText(part.text),
          ...when,
        };
      } else if (part.type === 'thinking' && typeof part.thinking === 'string' && part.thinking) {
        item = { kind: 'thinking', ...prepareText(part.thinking), ...when };
      } else if (part.type === 'tool_use') {
        item = {
          kind: 'tool_call',
          toolName: typeof part.name === 'string' ? part.name.slice(0, 80) : 'tool',
          ...prepareText(part.input ?? ''),
          ...when,
        };
      } else if (part.type === 'tool_result') {
        item = {
          kind: part.is_error === true ? 'tool_error' : 'tool_result',
          ...prepareText(part.content ?? ''),
          ...when,
        };
      }
      if (item && !push(item)) return { items, truncated: true };
    }
  }

  return { items, truncated: false };
}
