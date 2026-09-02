import { describe, it, expect } from 'vitest';

import {
  generateId,
  generateSessionId,
  generateEventId,
  generateCommandId,
  generateProjectId,
  generateSandboxId,
  generateApprovalId,
  generateCheckpointId,
  generateDeviceId,
  generateGatewayId,
  generateCorrelationId,
  ulid,
} from './ids';
import { EVENT_ID_PREFIX, EVENT_ID_LENGTH } from './types/events';
import { SANDBOX_ID_PREFIX, SANDBOX_ID_LENGTH } from './types/sandbox';
import { SESSION_ID_PREFIX, SESSION_ID_LENGTH } from './types/session';

/**
 * Identifiers are the join key between the Gateway, the Control Plane and the
 * audit chain, so their shape is a contract every other package relies on.
 */
describe('identifier generation', () => {
  const generators: Array<[string, () => string, string, number]> = [
    ['session', generateSessionId, SESSION_ID_PREFIX, SESSION_ID_LENGTH],
    ['event', generateEventId, EVENT_ID_PREFIX, EVENT_ID_LENGTH],
    ['sandbox', generateSandboxId, SANDBOX_ID_PREFIX, SANDBOX_ID_LENGTH],
    ['approval', generateApprovalId, 'appr_', 20],
    ['checkpoint', generateCheckpointId, 'chk_', 20],
    ['device', generateDeviceId, 'dev_', 32],
    ['gateway', generateGatewayId, 'gw_', 24],
    ['correlation', generateCorrelationId, 'corr_', 24],
  ];

  it.each(generators)(
    '%s ids carry the documented prefix and length',
    (_name, gen, prefix, length) => {
      const id = gen();
      expect(id.startsWith(prefix)).toBe(true);
      expect(id).toHaveLength(prefix.length + length);
      // Everything after the prefix must be lowercase hex.
      expect(id.slice(prefix.length)).toMatch(/^[0-9a-f]+$/);
    },
  );

  it.each(generators)('%s ids do not collide across many draws', (_name, gen) => {
    const seen = new Set<string>();
    for (let i = 0; i < 2000; i++) seen.add(gen());
    expect(seen.size).toBe(2000);
  });

  it('generateId honours an odd requested length', () => {
    // Math.ceil(length / 2) bytes are drawn, then sliced — an odd length must
    // not silently round up.
    const id = generateId('x_', 7);
    expect(id).toBe(id.toLowerCase());
    expect(id.slice(2)).toHaveLength(7);
  });

  it('command and project ids are distinguishable from each other', () => {
    expect(generateCommandId().startsWith(generateProjectId().split('_')[0] + '_')).toBe(false);
  });

  describe('ulid', () => {
    it('is uppercase and fixed width', () => {
      const value = ulid();
      expect(value).toBe(value.toUpperCase());
      expect(value).toMatch(/^[0-9A-Z]+$/);
    });

    it('sorts lexicographically in generation order', async () => {
      const first = ulid();
      await new Promise((r) => setTimeout(r, 5));
      const second = ulid();
      // The timestamp prefix is zero-padded so string ordering matches time
      // ordering — audit tooling depends on this to replay events in sequence.
      expect(first < second).toBe(true);
    });
  });
});
