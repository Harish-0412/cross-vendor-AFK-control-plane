import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';
import { createRedactor, DefaultClassifier, createRedactionProxy } from '@freebuff/redaction';

import { OpenCodeOutputParser } from '../src/output-parser';

/**
 * §4.7 of the pre-deployment audit: Phase 8's plan requires proving that
 * Phase 6's redaction pipeline survives a REAL adapter's parsed output, not
 * only the mock adapter's scripted `leaky_output` scenario
 * (gateway/core/tests/integration/redaction.test.ts covers that case, but
 * only against the mock).
 *
 * This reuses the same captured-and-replayed fixture output-parser.test.ts
 * already uses (a real OpenCode CLI run, recorded once), with a synthetic
 * secret injected into the tool's file content — the same
 * AWS-example-key-shaped fixture Phase 6's own corpus uses — and proves the
 * secret does not survive from OpenCodeOutputParser's normalized
 * EventEnvelope through RedactionProxy.redactEvent, exactly the chokepoint
 * gateway/core/src/gateway.ts calls on every event regardless of adapter.
 */
describe('OpenCode adapter output survives redaction', () => {
  it('scrubs a secret embedded in real (captured) OpenCode tool output', async () => {
    const fixture = await readFile(
      fileURLToPath(new URL('./fixtures/live-v1.18.23.ndjson', import.meta.url)),
      'utf8',
    );

    // AWS's own published example access key — never a real credential in a
    // test fixture, but pattern-shaped exactly like one, same convention
    // gateway/adapters/mock's leaky_output scenario and the redaction
    // spike's own corpus already use.
    const injectedSecret = 'AKIAIOSFODNN7EXAMPLE';
    const leakyFixture = fixture.replace(
      'OpenCode Phase 8 live validation.',
      `OpenCode Phase 8 live validation. AWS_ACCESS_KEY_ID=${injectedSecret}`,
    );
    expect(leakyFixture).not.toBe(fixture); // sanity: the replace actually matched

    const parser = new OpenCodeOutputParser('sess_redaction_test', 'dev_1');
    const events = leakyFixture
      .split(/\r?\n/)
      .filter(Boolean)
      .flatMap((line) => parser.parseLine(line));

    // Confirm the secret really is present in the parsed, pre-redaction
    // event stream — otherwise this test would trivially "pass" for the
    // wrong reason (the parser dropping the field, not redaction catching it).
    const rawSerialized = JSON.stringify(events);
    expect(rawSerialized).toContain(injectedSecret);

    const proxy = createRedactionProxy(createRedactor(), new DefaultClassifier());
    const redactedEvents = events.map((event) => proxy.redactEvent(event));

    const redactedSerialized = JSON.stringify(redactedEvents);
    expect(redactedSerialized).not.toContain(injectedSecret);
    // The rest of the event stream survives unredacted — only the secret
    // itself is scrubbed, not the whole payload.
    expect(redactedSerialized).toContain('opencode-live.txt');
  });
});
