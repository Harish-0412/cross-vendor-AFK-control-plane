import { generateSessionId, generateDeviceId } from '@freebuff/protocol';
import { describe, it, expect } from 'vitest';

import {
  SessionConfigSchema,
  SessionIdSchema,
  ResourceLimitsSchema,
  validateSessionId,
  toParseResult,
  assertValid,
} from './index';

/**
 * These schemas are the trust boundary for anything arriving from the Control
 * Plane or the local API, so the cases that matter are the rejections — a
 * schema that accepts malformed input is worse than no schema, because callers
 * stop checking.
 */
describe('SessionConfigSchema', () => {
  const valid = { projectRoot: '/srv/project', adapter: 'mock' };

  it('accepts a minimal valid config', () => {
    expect(SessionConfigSchema.safeParse(valid).success).toBe(true);
  });

  it('rejects an empty projectRoot', () => {
    expect(SessionConfigSchema.safeParse({ ...valid, projectRoot: '' }).success).toBe(false);
  });

  it('rejects a missing adapter', () => {
    expect(SessionConfigSchema.safeParse({ projectRoot: '/srv/project' }).success).toBe(false);
  });

  it('rejects an unknown approvalMode', () => {
    // 'always' is a plausible-looking value that must not silently pass through
    // to the policy layer.
    const result = SessionConfigSchema.safeParse({ ...valid, approvalMode: 'always' });
    expect(result.success).toBe(false);
  });

  it.each(['auto', 'ask', 'never'])('accepts approvalMode %s', (mode) => {
    expect(SessionConfigSchema.safeParse({ ...valid, approvalMode: mode }).success).toBe(true);
  });

  it('rejects a non-integer timeout', () => {
    expect(SessionConfigSchema.safeParse({ ...valid, timeout: 1.5 }).success).toBe(false);
  });

  it('rejects a negative timeout', () => {
    expect(SessionConfigSchema.safeParse({ ...valid, timeout: -1 }).success).toBe(false);
  });
});

describe('ResourceLimitsSchema', () => {
  it('accepts cpuPercent at the boundaries', () => {
    expect(ResourceLimitsSchema.safeParse({ cpuPercent: 1 }).success).toBe(true);
    expect(ResourceLimitsSchema.safeParse({ cpuPercent: 100 }).success).toBe(true);
  });

  it('rejects cpuPercent outside 1..100', () => {
    expect(ResourceLimitsSchema.safeParse({ cpuPercent: 0 }).success).toBe(false);
    expect(ResourceLimitsSchema.safeParse({ cpuPercent: 101 }).success).toBe(false);
  });

  it('rejects a zero or negative memory limit', () => {
    // A zero memory cap would otherwise reach the sandbox as "no memory".
    expect(ResourceLimitsSchema.safeParse({ memoryMb: 0 }).success).toBe(false);
    expect(ResourceLimitsSchema.safeParse({ memoryMb: -512 }).success).toBe(false);
  });
});

describe('SessionIdSchema', () => {
  it('accepts an id produced by the protocol generator', () => {
    expect(SessionIdSchema.safeParse(generateSessionId()).success).toBe(true);
  });

  it('rejects an id carrying a different entity prefix', () => {
    // Cross-entity id confusion is the bug this guards against.
    expect(SessionIdSchema.safeParse(generateDeviceId()).success).toBe(false);
  });

  it('rejects a truncated id', () => {
    expect(SessionIdSchema.safeParse(generateSessionId().slice(0, -2)).success).toBe(false);
  });

  it('validateSessionId agrees with the schema', () => {
    expect(validateSessionId(generateSessionId()).success).toBe(true);
    expect(validateSessionId('nonsense').success).toBe(false);
  });
});

describe('result helpers', () => {
  it('toParseResult surfaces a dotted path for each issue', () => {
    const result = toParseResult(
      SessionConfigSchema.safeParse({ projectRoot: '', adapter: 'mock' }),
    );
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.errors.map((e) => e.path)).toContain('projectRoot');
    }
  });

  it('toParseResult returns parsed data on success', () => {
    const result = toParseResult(
      SessionConfigSchema.safeParse({ projectRoot: '/p', adapter: 'mock' }),
    );
    expect(result.success).toBe(true);
    if (result.success) expect(result.data.adapter).toBe('mock');
  });

  it('assertValid returns the value when parsing succeeds', () => {
    const value = assertValid(
      SessionConfigSchema.safeParse({ projectRoot: '/p', adapter: 'mock' }),
    );
    expect(value.projectRoot).toBe('/p');
  });

  it('assertValid throws with the offending field named', () => {
    expect(() =>
      assertValid(
        SessionConfigSchema.safeParse({ projectRoot: '', adapter: 'mock' }),
        'bad config',
      ),
    ).toThrow(/bad config[\s\S]*projectRoot/);
  });
});
