import type { EventEnvelope, EventType } from '@odysseus/protocol';
import { EVENT_VERSION, generateEventId } from '@odysseus/protocol';

export interface ParsedAntigravityLine {
  envelopes: EventEnvelope[];
  conversationId?: string;
  terminal?: boolean;
  error?: string;
}

/**
 * Maps Antigravity's real 1.1.x `stream-json` records to vendor-neutral events.
 *
 * A `result` ends one turn, not the stdin-driven CLI process. Successful turns
 * therefore return the Odysseus session to an idle/running state so another
 * phone prompt can be delivered over the same authenticated conversation.
 */
export class AntigravityStreamParser {
  private nextSequence = 0;
  constructor(private readonly sessionId: string) {}

  parseLine(line: string): ParsedAntigravityLine {
    const text = line.trim();
    if (!text) return { envelopes: [] };

    let record: Record<string, unknown>;
    try {
      record = JSON.parse(text) as Record<string, unknown>;
    } catch {
      return {
        envelopes: [
          this.envelope('session.output', {
            stream: 'stdout',
            content: text,
            timestamp: new Date(),
          }),
        ],
      };
    }

    const event = string(record['event']);
    if (event === 'init') {
      const conversationId = string(record['conversation_id']);
      return {
        envelopes: [
          this.envelope('session.started', {
            adapter: 'antigravity',
            conversationId,
            configuration: object(record['init']),
          }),
        ],
        ...(conversationId ? { conversationId } : {}),
      };
    }

    if (event === 'step_update') {
      const step = object(record['step_update']);
      const conversationId = string(step['conversation_id']);
      const kind = string(step['step_type']);
      const state = string(step['state']);

      if (kind === 'user_input') {
        return {
          envelopes:
            state === 'DONE'
              ? [this.envelope('session.status_changed', { state: 'running', phase: 'working' })]
              : [],
          ...(conversationId ? { conversationId } : {}),
        };
      }

      if (kind === 'tool') {
        const info = object(step['tool_info']);
        const toolCallId =
          string(step['step_id']) ??
          (typeof step['step_index'] === 'number' ? `agy-step-${step['step_index']}` : undefined) ??
          generateEventId();
        const toolName = string(step['tool_name']) ?? string(info['name']) ?? 'agy.tool';
        return {
          envelopes: [
            this.envelope(
              state === 'DONE' ? 'session.tool_result' : 'session.tool_call',
              state === 'DONE'
                ? {
                    toolCallId,
                    toolName,
                    success: info['error'] === undefined,
                    output: info['result'] ?? info['output'],
                    error: info['error'],
                    durationMs: secondsToMilliseconds(step['duration_seconds']),
                  }
                : {
                    toolCallId,
                    toolName,
                    arguments: info,
                    timestamp: new Date(),
                  },
            ),
          ],
          ...(conversationId ? { conversationId } : {}),
        };
      }

      const delta = string(step['text_delta']);
      return {
        envelopes: delta
          ? [
              this.envelope('session.output', {
                stream: 'stdout',
                content: delta,
                timestamp: new Date(),
              }),
            ]
          : [],
        ...(conversationId ? { conversationId } : {}),
      };
    }

    if (event === 'result') {
      const result = object(record['result']);
      const conversationId = string(result['conversation_id']);
      const status = string(result['status']);
      if (status === 'SUCCESS') {
        const response = string(result['response']);
        const envelopes: EventEnvelope[] = [];
        if (response) {
          envelopes.push(
            this.envelope('session.message', {
              role: 'assistant',
              content: response,
              turnNumber: number(result['num_turns']),
            }),
          );
        }
        envelopes.push(
          this.envelope('session.status_changed', {
            state: 'running',
            phase: 'idle',
            usage: object(result['usage']),
            durationMs: secondsToMilliseconds(result['duration_seconds']),
          }),
        );
        return {
          envelopes,
          terminal: true,
          ...(conversationId ? { conversationId } : {}),
        };
      }

      const error =
        string(result['error']) ??
        (status ? `Antigravity turn ended with ${status}` : 'Antigravity failed');
      return {
        envelopes: [
          this.envelope('session.failed', {
            errorCode: status ?? 'ANTIGRAVITY_ERROR',
            errorMessage: error,
            fatal: false,
            durationMs: secondsToMilliseconds(result['duration_seconds']),
          }),
        ],
        terminal: true,
        error,
        ...(conversationId ? { conversationId } : {}),
      };
    }

    return {
      envelopes: [
        this.envelope('session.output', {
          stream: 'stdout',
          content: text,
          timestamp: new Date(),
        }),
      ],
    };
  }

  /** Backwards-compatible single-event view used by older adapter consumers. */
  parse(line: string): EventEnvelope | null {
    return this.parseLine(line).envelopes[0] ?? null;
  }

  /** Allocate synthetic adapter events on the same monotonic sequence. */
  createEvent(eventType: EventType, payload: unknown): EventEnvelope {
    return this.envelope(eventType, payload);
  }

  private envelope(eventType: EventType, payload: unknown): EventEnvelope {
    return {
      eventId: generateEventId(),
      eventVersion: EVENT_VERSION,
      eventType,
      sessionId: this.sessionId,
      sequence: this.nextSequence++,
      occurredAt: new Date(),
      payload,
    };
  }
}

function object(value: unknown): Record<string, unknown> {
  return typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : {};
}

function string(value: unknown): string | undefined {
  return typeof value === 'string' && value ? value : undefined;
}

function number(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function secondsToMilliseconds(value: unknown): number {
  const seconds = number(value);
  return seconds === undefined ? 0 : Math.max(0, Math.round(seconds * 1000));
}
