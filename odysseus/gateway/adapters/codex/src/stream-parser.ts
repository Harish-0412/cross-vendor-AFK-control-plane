import type { EventEnvelope, EventType } from '@odysseus/protocol';
import { EVENT_VERSION, generateEventId } from '@odysseus/protocol';

export interface ParsedCodexLine {
  envelopes: EventEnvelope[];
  threadId?: string;
  terminal?: boolean;
  error?: string;
}

/** Maps the documented `codex exec --json` JSONL events to vendor-neutral events. */
export class CodexStreamParser {
  private sequence = 0;
  constructor(private readonly sessionId: string) {}

  parseLine(line: string): ParsedCodexLine {
    const text = line.trim();
    if (!text) return { envelopes: [] };
    let value: Record<string, unknown>;
    try {
      value = JSON.parse(text) as Record<string, unknown>;
    } catch {
      return { envelopes: [this.event('session.output', { stream: 'stdout', content: text })] };
    }
    const type = String(value['type'] ?? '');
    if (type === 'thread.started') {
      const threadId = string(value['thread_id']) ?? string(value['threadId']);
      return {
        envelopes: [this.event('session.started', { adapter: 'codex', threadId })],
        ...(threadId ? { threadId } : {}),
      };
    }
    if (type === 'turn.started')
      return { envelopes: [this.event('session.status_changed', { state: 'running' })] };
    if (type === 'turn.completed')
      return {
        envelopes: [this.event('session.completed', { usage: value['usage'] })],
        terminal: true,
      };
    if (type === 'turn.failed' || type === 'error') {
      const error =
        string(value['message']) ??
        string((value['error'] as Record<string, unknown> | undefined)?.['message']) ??
        'Codex reported an error';
      return { envelopes: [this.event('session.failed', { error })], terminal: true, error };
    }
    const item = value['item'] as Record<string, unknown> | undefined;
    if ((type === 'item.started' || type === 'item.completed' || type === 'item.updated') && item) {
      const itemType = String(item['type'] ?? '');
      if (itemType === 'agent_message')
        return {
          envelopes: [
            this.event('session.message', {
              role: 'assistant',
              content: string(item['text']) ?? '',
            }),
          ],
        };
      if (itemType === 'reasoning')
        return {
          envelopes: [
            this.event('session.thinking', {
              content: string(item['text']) ?? string(item['summary']) ?? '',
            }),
          ],
        };
      if (itemType === 'command_execution' || itemType === 'mcp_tool_call') {
        const completed = type === 'item.completed';
        return {
          envelopes: [
            this.event(
              completed
                ? item['status'] === 'failed'
                  ? 'session.tool_error'
                  : 'session.tool_result'
                : 'session.tool_call',
              completed
                ? {
                    toolCallId: item['id'],
                    output: item['aggregated_output'] ?? item['result'],
                    status: item['status'],
                  }
                : {
                    toolCallId: item['id'],
                    name: itemType === 'command_execution' ? 'shell' : item['tool'],
                    arguments: item['command'] ?? item['arguments'],
                  },
            ),
          ],
        };
      }
      if (itemType === 'file_change')
        return {
          envelopes: [
            this.event('session.file_changed', {
              changes: item['changes'],
              status: item['status'],
            }),
          ],
        };
    }
    return { envelopes: [this.event('session.output', { stream: 'stdout', content: text })] };
  }

  private event(eventType: EventType, payload: unknown): EventEnvelope {
    return {
      eventId: generateEventId(),
      eventType,
      eventVersion: EVENT_VERSION,
      sessionId: this.sessionId,
      sequence: this.sequence++,
      occurredAt: new Date(),
      payload,
    } as EventEnvelope;
  }
}
const string = (value: unknown): string | undefined =>
  typeof value === 'string' && value ? value : undefined;
