import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

import { GatewayPolicyCache } from '../src/index';
import type { PolicyVersion, PolicyEvaluationContext, Decision } from '@freebuff/protocol';

/**
 * §4.2 of the pre-deployment audit: this module (the Gateway-side local
 * policy cache — the one piece of Phase 5's design that sits directly on
 * the advisory/authoritative boundary) had zero tests. These cover every
 * behavior the class actually implements, and pin down two real bugs found
 * while writing this suite (both fixed alongside these tests, not just
 * documented): a failed refresh silently kept serving an already-expired
 * cached policy forever, and a rejected fetchPolicyVersion() propagated as
 * an unhandled exception instead of degrading gracefully.
 */
describe('GatewayPolicyCache', () => {
  const makeVersion = (id: string): PolicyVersion => ({
    id,
    version: id,
    description: 'test policy',
    rules: [],
    createdAt: new Date(),
    createdBy: 'test',
    isActive: true,
  });

  const baseContext: PolicyEvaluationContext = {
    capability: 'filesystem.read',
    riskClass: 'low',
    trustProfile: 'default',
    deviceStatus: 'trusted',
    userId: 'usr_1',
  };

  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('fetches and caches a policy version on first access', async () => {
    const fetchPolicyVersion = vi.fn().mockResolvedValue(makeVersion('p_1'));
    const cache = new GatewayPolicyCache({
      fetchPolicyVersion,
      confirmWithControlPlane: vi.fn(),
    });

    const version = await cache.getPolicyVersion();
    expect(version?.version).toBe('p_1');
    expect(fetchPolicyVersion).toHaveBeenCalledTimes(1);
  });

  it('serves the cached version without re-fetching before the TTL expires', async () => {
    const fetchPolicyVersion = vi.fn().mockResolvedValue(makeVersion('p_1'));
    const cache = new GatewayPolicyCache({
      fetchPolicyVersion,
      confirmWithControlPlane: vi.fn(),
      cacheTtlMs: 60_000,
    });

    await cache.getPolicyVersion();
    vi.advanceTimersByTime(30_000);
    await cache.getPolicyVersion();

    expect(fetchPolicyVersion).toHaveBeenCalledTimes(1);
  });

  it('refetches once the TTL has expired', async () => {
    const fetchPolicyVersion = vi
      .fn()
      .mockResolvedValueOnce(makeVersion('p_1'))
      .mockResolvedValueOnce(makeVersion('p_2'));
    const cache = new GatewayPolicyCache({
      fetchPolicyVersion,
      confirmWithControlPlane: vi.fn(),
      cacheTtlMs: 60_000,
    });

    await cache.getPolicyVersion();
    vi.advanceTimersByTime(61_000);
    const second = await cache.getPolicyVersion();

    expect(fetchPolicyVersion).toHaveBeenCalledTimes(2);
    expect(second?.version).toBe('p_2');
  });

  it('regression: does not serve a stale, expired version forever after a failed refresh', async () => {
    // First fetch succeeds with a very short TTL. Once expired, the refetch
    // resolves null (simulating the tunnel being down). Before the fix,
    // getPolicyVersion() returned `this.cache?.version ?? null` regardless
    // of whether that cache entry was still within its TTL — so the stale
    // p_1 kept being returned indefinitely instead of null.
    const fetchPolicyVersion = vi
      .fn()
      .mockResolvedValueOnce(makeVersion('p_1'))
      .mockResolvedValueOnce(null);
    const cache = new GatewayPolicyCache({
      fetchPolicyVersion,
      confirmWithControlPlane: vi.fn(),
      cacheTtlMs: 1_000,
    });

    const first = await cache.getPolicyVersion();
    expect(first?.version).toBe('p_1');

    vi.advanceTimersByTime(2_000);
    const afterFailedRefresh = await cache.getPolicyVersion();

    expect(afterFailedRefresh).toBeNull();
    expect(cache.isCacheFresh()).toBe(false);
  });

  it('regression: a rejected fetchPolicyVersion degrades to null instead of throwing', async () => {
    const fetchPolicyVersion = vi.fn().mockRejectedValue(new Error('tunnel down'));
    const cache = new GatewayPolicyCache({
      fetchPolicyVersion,
      confirmWithControlPlane: vi.fn(),
    });

    await expect(cache.getPolicyVersion()).resolves.toBeNull();
  });

  it('deduplicates concurrent refreshes into a single fetch', async () => {
    let resolveFetch: (v: PolicyVersion) => void = () => {};
    const fetchPolicyVersion = vi.fn().mockImplementation(
      () =>
        new Promise<PolicyVersion>((resolve) => {
          resolveFetch = resolve;
        }),
    );
    const cache = new GatewayPolicyCache({
      fetchPolicyVersion,
      confirmWithControlPlane: vi.fn(),
    });

    const p1 = cache.getPolicyVersion();
    const p2 = cache.getPolicyVersion();
    resolveFetch(makeVersion('p_1'));
    const [r1, r2] = await Promise.all([p1, p2]);

    expect(fetchPolicyVersion).toHaveBeenCalledTimes(1);
    expect(r1?.version).toBe('p_1');
    expect(r2?.version).toBe('p_1');
  });

  it('evaluate() runs the shared policy-engine function against the cached version', async () => {
    const fetchPolicyVersion = vi.fn().mockResolvedValue(makeVersion('p_1'));
    const cache = new GatewayPolicyCache({
      fetchPolicyVersion,
      confirmWithControlPlane: vi.fn(),
    });
    await cache.getPolicyVersion();

    const decision: Decision = cache.evaluate('filesystem.read', 'low', baseContext);
    expect(decision.decision).toBe('allow');
  });

  it('evaluate() with no cached policy still returns a decision (fail-safe defaults apply)', () => {
    const cache = new GatewayPolicyCache({
      fetchPolicyVersion: vi.fn().mockResolvedValue(null),
      confirmWithControlPlane: vi.fn(),
    });

    // No getPolicyVersion() call yet, so no policy is cached at all.
    const decision = cache.evaluate('deployment.execute', 'critical', {
      ...baseContext,
      capability: 'deployment.execute',
      riskClass: 'critical',
    });
    expect(decision.decision).toBe('require_approval');
  });

  it('confirm() delegates to the supplied confirmWithControlPlane callback, unmodified', async () => {
    const confirmed: Decision = { decision: 'allow', policyVersion: 'p_1' };
    const confirmWithControlPlane = vi.fn().mockResolvedValue(confirmed);
    const cache = new GatewayPolicyCache({
      fetchPolicyVersion: vi.fn().mockResolvedValue(null),
      confirmWithControlPlane,
    });

    const result = await cache.confirm('git.push', 'high', {
      deviceId: 'dev_1',
      userId: 'usr_1',
    });

    expect(confirmWithControlPlane).toHaveBeenCalledWith('git.push', 'high', {
      deviceId: 'dev_1',
      userId: 'usr_1',
    });
    expect(result).toBe(confirmed);
  });

  it('getCacheStatus reports empty state before any fetch', () => {
    const cache = new GatewayPolicyCache({
      fetchPolicyVersion: vi.fn(),
      confirmWithControlPlane: vi.fn(),
    });

    expect(cache.getCacheStatus()).toEqual({
      fresh: false,
      fetchedAt: null,
      expiresAt: null,
      version: null,
    });
    expect(cache.isCacheFresh()).toBe(false);
  });

  it('getCacheStatus reports fresh state and the correct version id after a fetch', async () => {
    const cache = new GatewayPolicyCache({
      fetchPolicyVersion: vi.fn().mockResolvedValue(makeVersion('p_7')),
      confirmWithControlPlane: vi.fn(),
      cacheTtlMs: 60_000,
    });

    await cache.getPolicyVersion();
    const status = cache.getCacheStatus();

    expect(status.fresh).toBe(true);
    expect(status.version).toBe('p_7');
    expect(status.fetchedAt).toBeInstanceOf(Date);
    expect(status.expiresAt).toBeInstanceOf(Date);
  });
});
