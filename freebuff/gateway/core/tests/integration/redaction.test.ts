import { describe, expect, it, beforeEach, afterEach, vi } from 'vitest';
import { createGateway, GatewayImpl } from '../../src/gateway';
import { SessionConfig } from '@freebuff/protocol/types/session';
import { EventEnvelope } from '@freebuff/protocol/types/events';

describe('Gateway Redaction Integration', () => {
  let gateway: GatewayImpl;

  beforeEach(() => {
    gateway = createGateway({
      redaction: {
        enabled: true,
        customPatterns: [],
      },
    });
  });

  afterEach(async () => {
    await gateway.shutdown();
  });

  it('scrubs leaky output before it reaches the event bus and checkpoint store', async () => {
    const config: SessionConfig = {
      projectRoot: process.cwd(),
      adapter: 'mock',
      metadata: {
        scenario: 'leaky_output',
      },
    };

    const events: EventEnvelope[] = [];
    const unsub = gateway.subscribeToEvents({
      onEvent: (e) => events.push(e),
    });

    const session = await gateway.createSession(config);

    await new Promise((r) => setTimeout(r, 2000));
    unsub();

    const outputEvents = events.filter((e) => e.eventType === 'session.output');
    expect(outputEvents.length).toBeGreaterThan(0);

    for (const event of outputEvents) {
      const content = (event.payload as any).content;
      // It should NOT contain the secret
      expect(content).not.toContain('AKIAIOSFODNN7EXAMPLE');
      // It SHOULD contain the redacted placeholder
      expect(content).toContain('[REDACTED_AWS_ACCESS_KEY]');
    }

    // Verify stats were recorded
    const stats = gateway.getModules().redactionProxy.getStats();
    expect(stats.secretsRedacted).toBeGreaterThan(0);
    expect(stats.eventsProcessed).toBeGreaterThan(0);
  });
});
