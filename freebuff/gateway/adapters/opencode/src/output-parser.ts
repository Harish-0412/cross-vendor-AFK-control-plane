import type { EventEnvelope, EventType } from '@freebuff/protocol';
import { EVENT_VERSION, generateEventId } from '@freebuff/protocol';

import type { OpenCodeNativeEvent } from './types';

/** Maps the real `opencode run --format json` NDJSON stream into Freebuff events. */
export class OpenCodeOutputParser {
  private sequence = 0;
  constructor(
    private readonly sessionId: string,
    private readonly deviceId?: string,
  ) {}

  parseLine(line: string): EventEnvelope[] {
    try {
      return this.parse(JSON.parse(line) as OpenCodeNativeEvent);
    } catch {
      return [];
    }
  }

  parse(event: OpenCodeNativeEvent): EventEnvelope[] {
    const type = event.type.toLowerCase();
    const part = record(event.part);
    if (type === 'tool_use' && part['type'] === 'tool') return this.toolEvents(part);
    if (type === 'text' && typeof part['text'] === 'string')
      return [
        this.envelope('session.output', {
          stream: 'stdout',
          content: part['text'],
          timestamp: new Date(),
        }),
      ];
    if (type === 'error')
      return [
        this.envelope('session.failed', {
          errorMessage: record(event.error)['message'] ?? 'OpenCode failed',
        }),
      ];
    if (type === 'step_start' || type === 'session.created')
      return [this.envelope('session.started', { opencodeSessionId: nativeSessionId(event) })];
    if (type === 'step_finish' && part['reason'] === 'stop')
      return [this.envelope('session.completed', { summary: 'OpenCode run completed' })];
    return [];
  }

  private toolEvents(part: Record<string, unknown>): EventEnvelope[] {
    const state = record(part['state']);
    const input = record(state['input']);
    const metadata = record(state['metadata']);
    const toolCallId = string(part['callID']) ?? generateEventId();
    const toolName = string(part['tool']) ?? 'opencode.tool';
    const events = [
      this.envelope('session.tool_call', {
        toolCallId,
        toolName,
        arguments: input,
        timestamp: new Date(),
      }),
    ];
    const filePath = string(input['filePath'], input['path'], metadata['filepath']);
    if (filePath && ['write', 'edit', 'patch'].includes(toolName))
      events.push(
        this.envelope('session.file_changed', {
          path: filePath,
          action: metadata['exists'] === false ? 'created' : 'modified',
          timestamp: new Date(),
        }),
      );
    events.push(
      this.envelope('session.tool_result', {
        toolCallId,
        toolName,
        success: state['status'] !== 'error',
        output: state['output'],
        error: record(state['error'])['message'],
        durationMs: duration(state),
      }),
    );
    return events;
  }

  private envelope(eventType: EventType, payload: unknown): EventEnvelope {
    return {
      eventId: generateEventId(),
      eventVersion: EVENT_VERSION,
      eventType,
      sessionId: this.sessionId,
      ...(this.deviceId ? { deviceId: this.deviceId } : {}),
      sequence: this.sequence++,
      occurredAt: new Date(),
      payload,
    };
  }
}
function record(value: unknown): Record<string, unknown> {
  return typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : {};
}
function string(...values: unknown[]): string | undefined {
  return values.find((value): value is string => typeof value === 'string');
}
function duration(state: Record<string, unknown>): number {
  const time = record(state['time']);
  const start = typeof time['start'] === 'number' ? time['start'] : 0;
  const end = typeof time['end'] === 'number' ? time['end'] : start;
  return Math.max(0, end - start);
}
function nativeSessionId(event: OpenCodeNativeEvent): string | undefined {
  return string(event.sessionID, event.sessionId);
}
