import type { EventEnvelope, EventType } from '@freebuff/protocol';
import { EVENT_VERSION, generateEventId } from '@freebuff/protocol';
import type { OpenCodeNativeEvent } from './types';

/** Maps OpenCode `run --format json` NDJSON records to Freebuff's vendor-neutral events. */
export class OpenCodeOutputParser {
  private sequence = 0;

  constructor(private readonly sessionId: string, private readonly deviceId?: string) {}

  parseLine(line: string): EventEnvelope | null {
    let event: OpenCodeNativeEvent;
    try { event = JSON.parse(line) as OpenCodeNativeEvent; } catch { return null; }
    return this.parse(event);
  }

  parse(event: OpenCodeNativeEvent): EventEnvelope | null {
    const properties = record(event.properties);
    const part = record(event.part ?? properties['part']);
    const type = event.type.toLowerCase();
    if (type === 'session.created' || type === 'session.updated') {
      return this.envelope('session.started', { opencodeSessionId: nativeSessionId(event), ...properties });
    }
    if (type.includes('tool') && /(complete|result|finish|error)/.test(type)) {
      return this.envelope(type.includes('error') ? 'session.tool_error' : 'session.tool_result', {
        toolCallId: stringValue(properties['callID'], properties['id']) ?? generateEventId(),
        toolName: stringValue(properties['tool'], properties['name']) ?? 'opencode.tool',
        success: !type.includes('error'), output: properties['output'] ?? properties['result'], error: properties['error'], durationMs: numberValue(properties['duration']) ?? 0,
      });
    }
    if (type.includes('tool') && /(start|call|pending)/.test(type)) {
      return this.envelope('session.tool_call', {
        toolCallId: stringValue(properties['callID'], properties['id']) ?? generateEventId(),
        toolName: stringValue(properties['tool'], properties['name']) ?? 'opencode.tool',
        arguments: record(properties['input'], properties['arguments']), timestamp: new Date(),
      });
    }
    if (type.includes('file') && /(change|write|edit|update)/.test(type)) {
      return this.envelope('session.file_changed', {
        path: stringValue(properties['path'], properties['file']) ?? 'unknown',
        action: fileAction(properties['action'], type), timestamp: new Date(),
      });
    }
    if (type.includes('message') || type.includes('text') || part['type'] === 'text') {
      const content = stringValue(properties['text'], properties['delta'], part['text'], part['content']);
      return content === undefined ? null : this.envelope('session.output', { stream: 'stdout', content, timestamp: new Date() });
    }
    if (type.includes('complete') || type === 'session.idle') return this.envelope('session.completed', { summary: properties['summary'] });
    if (type.includes('error') || type.includes('failed')) return this.envelope('session.failed', { errorMessage: stringValue(properties['error'], properties['message']) ?? 'OpenCode failed' });
    return null;
  }

  private envelope(eventType: EventType, payload: unknown): EventEnvelope {
    return {
      eventId: generateEventId(), eventVersion: EVENT_VERSION, eventType, sessionId: this.sessionId,
      ...(this.deviceId ? { deviceId: this.deviceId } : {}), sequence: this.sequence++, occurredAt: new Date(), payload,
    };
  }
}

function record(...values: unknown[]): Record<string, unknown> { return values.find((value): value is Record<string, unknown> => typeof value === 'object' && value !== null) ?? {}; }
function stringValue(...values: unknown[]): string | undefined { return values.find((value): value is string => typeof value === 'string'); }
function numberValue(value: unknown): number | undefined { return typeof value === 'number' ? value : undefined; }
function nativeSessionId(event: OpenCodeNativeEvent): string | undefined { return stringValue(event.sessionID, event.sessionId); }
function fileAction(value: unknown, type: string): 'created' | 'modified' | 'deleted' { if (value === 'created' || type.includes('create')) return 'created'; if (value === 'deleted' || type.includes('delete')) return 'deleted'; return 'modified'; }
