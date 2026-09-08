import { describe, it, expect, vi } from 'vitest';
import { createRedactionProxy } from './redaction-proxy';
import { Redactor, Classifier, DataClassification } from './types';
import { EventEnvelope } from '@freebuff/protocol/types/events';

describe('RedactionProxy', () => {
  const mockRedactor: Redactor = {
    redact: vi.fn((text) => ({ text: '[REDACTED]', matches: [{ type: 'custom', length: 10, index: 0, value: 'secret', name: 'secret', pattern: '.*' }], redacted: true, originalLength: text.length, redactedLength: 10 })),
    redactObject: vi.fn((obj) => ({ redacted: true })),
    redactStream: vi.fn(),
    addPattern: vi.fn(),
    removePattern: vi.fn(),
    getPatterns: vi.fn(() => []),
  };

  const mockClassifier: Classifier = {
    classify: vi.fn((text) => ({ level: 'internal', categories: [], pii: false, secrets: false, credentials: false })),
    shouldRedact: vi.fn(() => true),
  };

  const proxy = createRedactionProxy(mockRedactor, mockClassifier);

  const baseEvent: Omit<EventEnvelope, 'eventType' | 'payload'> = {
    eventId: 'evt_12345678901234567890123456789012',
    eventVersion: 1,
    sessionId: 'sess_123',
    sequence: 1,
    occurredAt: new Date(),
  };

  it('bypasses redaction if disabled', () => {
    const disabledProxy = createRedactionProxy(mockRedactor, mockClassifier, { enabled: false });
    const event: EventEnvelope = {
      ...baseEvent,
      eventType: 'session.output',
      payload: { stream: 'stdout', content: 'hello secret', timestamp: new Date() }
    };

    const result = disabledProxy.redactEvent(event);
    expect(result).toBe(event);
    expect(mockRedactor.redact).not.toHaveBeenCalled();
  });

  it('redacts session.output', () => {
    const event: EventEnvelope = {
      ...baseEvent,
      eventType: 'session.output',
      payload: { stream: 'stdout', content: 'hello secret', timestamp: new Date() }
    };

    const result = proxy.redactEvent(event);
    expect((result.payload as any).content).toBe('[REDACTED]');
  });

  it('redacts session.message and its thinking field', () => {
    const event: EventEnvelope = {
      ...baseEvent,
      eventType: 'session.message',
      payload: { role: 'assistant', content: 'hello secret', thinking: 'thinking secret' }
    };

    const result = proxy.redactEvent(event);
    expect((result.payload as any).content).toBe('[REDACTED]');
    expect((result.payload as any).thinking).toBe('[REDACTED]');
  });

  it('redacts session.tool_call arguments', () => {
    const event: EventEnvelope = {
      ...baseEvent,
      eventType: 'session.tool_call',
      payload: { toolCallId: 'call_1', toolName: 'test', arguments: { arg: 'secret' }, timestamp: new Date() }
    };

    const result = proxy.redactEvent(event);
    expect((result.payload as any).arguments).toEqual({ redacted: true });
  });

  it('redacts session.tool_result output', () => {
    const event: EventEnvelope = {
      ...baseEvent,
      eventType: 'session.tool_result',
      payload: { toolCallId: 'call_1', toolName: 'test', success: true, output: { out: 'secret' }, durationMs: 10 }
    };

    const result = proxy.redactEvent(event);
    expect((result.payload as any).output).toEqual({ redacted: true });
  });

  it('blocks restricted payloads entirely', () => {
    const strictClassifier: Classifier = {
      classify: vi.fn(() => ({ level: 'restricted', categories: [], pii: false, secrets: false, credentials: false })),
      shouldRedact: vi.fn(() => true),
    };
    const strictProxy = createRedactionProxy(mockRedactor, strictClassifier);

    const event: EventEnvelope = {
      ...baseEvent,
      eventType: 'session.output',
      payload: { stream: 'stdout', content: 'massive restricted dump', timestamp: new Date() }
    };

    const result = strictProxy.redactEvent(event);
    expect(result.payload).toEqual({
      payload_blocked: true,
      reason: 'restricted_content',
      original_type: 'session.output'
    });
  });

  it('tracks stats correctly', () => {
    const stats = proxy.getStats();
    expect(stats.eventsProcessed).toBeGreaterThan(0);
    expect(stats.secretsRedacted).toBeGreaterThan(0);
  });
});
