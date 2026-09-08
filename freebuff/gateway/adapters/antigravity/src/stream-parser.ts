import type { EventEnvelope, EventType } from '@freebuff/protocol';
import { EVENT_VERSION, generateEventId } from '@freebuff/protocol';

/** Parser for Antigravity's documented `--output-format stream-json` records. */
export class AntigravityStreamParser {
  private nextSequence = 0;
  constructor(private readonly sessionId: string) {}

  parse(line: string): EventEnvelope | null {
    let record: Record<string, unknown>;
    try {
      record = JSON.parse(line) as Record<string, unknown>;
    } catch {
      return null;
    }
    const event = string(record['event']);
    if (event === 'init')
      return this.envelope('session.started', { configuration: object(record['init']) });
    if (event === 'step_update') {
      const step = object(record['step_update']);
      const kind = string(step['step_type']);
      const state = string(step['state']);
      if (kind === 'tool') {
        const info = object(step['tool_info']);
        return this.envelope(
          state === 'DONE' ? 'session.tool_result' : 'session.tool_call',
          state === 'DONE'
            ? {
                toolCallId: string(step['step_id']) ?? generateEventId(),
                toolName: string(step['tool_name']) ?? 'agy.tool',
                success: true,
                output: info['result'],
                durationMs: number(step['duration_seconds']) ?? 0,
              }
            : {
                toolCallId: string(step['step_id']) ?? generateEventId(),
                toolName: string(step['tool_name']) ?? 'agy.tool',
                arguments: info,
                timestamp: new Date(),
              },
        );
      }
      const delta = string(step['text_delta']);
      return delta
        ? this.envelope('session.output', {
            stream: 'stdout',
            content: delta,
            timestamp: new Date(),
          })
        : null;
    }
    if (event === 'result') {
      const result = object(record['result']);
      const status = string(result['status']);
      return this.envelope(
        status === 'SUCCESS' ? 'session.completed' : 'session.failed',
        status === 'SUCCESS'
          ? { summary: result['response'] }
          : { errorMessage: result['error'] ?? status ?? 'Antigravity failed' },
      );
    }
    return null;
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
  return typeof value === 'string' ? value : undefined;
}
function number(value: unknown): number | undefined {
  return typeof value === 'number' ? value : undefined;
}
