import { describe, it, expect, beforeEach, vi } from 'vitest';

import {
  type RevocationStore,
  type RevocationChecker,
  createRevocationStore,
  createRevocationChecker,
  type RevocationEntry,
} from '../revocation';

describe('RevocationStore', () => {
  let store: RevocationStore;

  beforeEach(() => {
    store = createRevocationStore({ maxEntries: 100, cacheTtlMs: 60_000 });
  });

  it('should start empty', () => {
    expect(store.size()).toBe(0);
    expect(store.getRevocationList()).toEqual([]);
  });

  it('should add and retrieve revocation entries', () => {
    const entry: RevocationEntry = {
      deviceId: 'dev_test123',
      revokedAt: new Date(),
      reason: 'user_initiated',
      revokedBy: 'user_1',
      affectedCertificates: ['cert_abc'],
      effectiveImmediately: true,
    };

    store.add(entry);
    expect(store.size()).toBe(1);
    expect(store.get('dev_test123')).toEqual(entry);
  });

  it('should report revocation status correctly', () => {
    const entry: RevocationEntry = {
      deviceId: 'dev_test123',
      revokedAt: new Date(),
      reason: 'compromise_suspected',
      revokedBy: 'admin',
      affectedCertificates: ['cert_abc'],
      effectiveImmediately: true,
    };

    store.add(entry);

    const status = store.isRevoked('dev_test123', 'cert_abc');
    expect(status.revoked).toBe(true);
    expect(status.reason).toBe('compromise_suspected');
    expect(status.revokedBy).toBe('admin');
  });

  it('should not report as revoked for unknown device', () => {
    const status = store.isRevoked('dev_unknown');
    expect(status.revoked).toBe(false);
  });

  it('should remove revocation entries', () => {
    store.add({
      deviceId: 'dev_remove',
      revokedAt: new Date(),
      reason: 'policy_violation',
      revokedBy: 'system',
      affectedCertificates: [],
      effectiveImmediately: true,
    });

    expect(store.size()).toBe(1);
    expect(store.remove('dev_remove')).toBe(true);
    expect(store.size()).toBe(0);
  });

  it('should respect max entries limit', () => {
    const smallStore = createRevocationStore({ maxEntries: 3 });

    smallStore.add({
      deviceId: 'd1',
      revokedAt: new Date(),
      reason: 'user_initiated',
      revokedBy: 'u',
      affectedCertificates: [],
      effectiveImmediately: true,
    });
    smallStore.add({
      deviceId: 'd2',
      revokedAt: new Date(),
      reason: 'user_initiated',
      revokedBy: 'u',
      affectedCertificates: [],
      effectiveImmediately: true,
    });
    smallStore.add({
      deviceId: 'd3',
      revokedAt: new Date(),
      reason: 'user_initiated',
      revokedBy: 'u',
      affectedCertificates: [],
      effectiveImmediately: true,
    });

    expect(smallStore.size()).toBe(3);

    // Adding 4th should evict oldest
    smallStore.add({
      deviceId: 'd4',
      revokedAt: new Date(),
      reason: 'user_initiated',
      revokedBy: 'u',
      affectedCertificates: [],
      effectiveImmediately: true,
    });
    expect(smallStore.size()).toBe(3);
  });

  it('should track refresh status', () => {
    expect(store.needsRefresh()).toBe(true);

    store.markRefreshed();
    expect(store.needsRefresh()).toBe(false);
    expect(store.getLastRefreshAt()).toBeInstanceOf(Date);
  });

  it('should import batches', () => {
    const entries: RevocationEntry[] = [
      {
        deviceId: 'd1',
        revokedAt: new Date(),
        reason: 'user_initiated',
        revokedBy: 'u',
        affectedCertificates: [],
        effectiveImmediately: true,
      },
      {
        deviceId: 'd2',
        revokedAt: new Date(),
        reason: 'user_initiated',
        revokedBy: 'u',
        affectedCertificates: [],
        effectiveImmediately: true,
      },
      {
        deviceId: 'd3',
        revokedAt: new Date(),
        reason: 'user_initiated',
        revokedBy: 'u',
        affectedCertificates: [],
        effectiveImmediately: true,
      },
    ];

    const added = store.importBatch(entries);
    expect(added).toBe(3);
    expect(store.size()).toBe(3);

    // Importing same batch should not add duplicates
    const addedAgain = store.importBatch(entries);
    expect(addedAgain).toBe(0);
    expect(store.size()).toBe(3);
  });

  it('should emit revocation events', () => {
    const listener = vi.fn();
    store.onRevocation(listener);

    const entry: RevocationEntry = {
      deviceId: 'dev_event',
      revokedAt: new Date(),
      reason: 'user_initiated',
      revokedBy: 'u',
      affectedCertificates: [],
      effectiveImmediately: true,
    };
    store.add(entry);

    expect(listener).toHaveBeenCalledWith(entry);
  });

  it('should clear all entries', () => {
    store.add({
      deviceId: 'd1',
      revokedAt: new Date(),
      reason: 'user_initiated',
      revokedBy: 'u',
      affectedCertificates: [],
      effectiveImmediately: true,
    });
    store.clear();
    expect(store.size()).toBe(0);
    expect(store.needsRefresh()).toBe(true);
  });
});

describe('RevocationChecker', () => {
  let store: RevocationStore;
  let checker: RevocationChecker;

  beforeEach(() => {
    store = createRevocationStore();
    checker = createRevocationChecker(store);
  });

  it('should check local revocation store', async () => {
    store.add({
      deviceId: 'dev_local',
      revokedAt: new Date(),
      reason: 'user_initiated',
      revokedBy: 'u',
      affectedCertificates: [],
      effectiveImmediately: true,
    });

    const status = await checker.check('dev_local');
    expect(status.revoked).toBe(true);
  });

  it('should report non-revoked device', async () => {
    const status = await checker.check('dev_unknown');
    expect(status.revoked).toBe(false);
  });

  it('should refresh from remote source', async () => {
    const mockClient = {
      checkRevocation: vi
        .fn()
        .mockResolvedValue({ deviceId: 'dev_remote', revoked: false, affectedCertificates: [] }),
      fetchRevocationList: vi.fn().mockResolvedValue([]),
    };
    checker.setClient(mockClient);

    const count = await checker.refreshFromSource();
    expect(count).toBe(0);
    expect(mockClient.fetchRevocationList).toHaveBeenCalled();
  });

  it('should handle auto-refresh start/stop', () => {
    checker.startAutoRefresh(1000);
    checker.stopAutoRefresh(); // should not throw
  });

  it('should shutdown cleanly', () => {
    checker.startAutoRefresh(1000);
    checker.shutdown();
    expect(store.size()).toBe(0);
  });
});
