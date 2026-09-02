import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';

import { describe, test, expect, beforeEach, afterEach } from 'vitest';

import { createCheckpointStore, type CheckpointStore } from '../src/checkpoint-store';

describe('CheckpointStore', () => {
  let store: CheckpointStore;
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'freebuff-chk-'));
  });

  afterEach(async () => {
    await store.shutdown().catch(() => {});
    try {
      await fs.rm(tempDir, { recursive: true, force: true });
    } catch {
      // swallow
    }
  });

  test('create and get checkpoint', () => {
    store = createCheckpointStore();
    const cp = store.create({
      sessionId: 'sess_test123',
      gatewayId: 'gw_test',
      adapterId: 'mock',
      projectId: 'proj_test',
    });

    expect(cp.sessionId).toBe('sess_test123');
    expect(cp.gatewayId).toBe('gw_test');
    expect(cp.adapterId).toBe('mock');
    expect(cp.sessionState).toBe('initializing');
    expect(cp.lastReceivedSequence).toBe(-1);
    expect(cp.lastSentSequence).toBe(-1);
    expect(cp.eventCount).toBe(0);
    expect(cp.reconnectState).toBe('idle');
    expect(cp.reconnectCount).toBe(0);
    expect(cp.needsReconciliation).toBe(false);
    expect(cp.pendingAckEvents).toEqual([]);

    const retrieved = store.get('sess_test123');
    expect(retrieved?.sessionId).toBe('sess_test123');
  });

  test('getOrThrow throws for missing checkpoint', () => {
    store = createCheckpointStore();
    expect(() => store.getOrThrow('sess_nonexistent')).toThrow('Checkpoint not found');
  });

  test('updateReceivedSequence increments count', () => {
    store = createCheckpointStore();
    store.create({
      sessionId: 'sess_1',
      gatewayId: 'gw_1',
      adapterId: 'mock',
      projectId: 'proj_1',
    });

    const cp = store.updateReceivedSequence('sess_1', 5);
    expect(cp.lastReceivedSequence).toBe(5);
    expect(cp.eventCount).toBe(1);

    const cp2 = store.updateReceivedSequence('sess_1', 10);
    expect(cp2.lastReceivedSequence).toBe(10);
    expect(cp2.eventCount).toBe(2);

    // Lower sequence should not decrease the value
    const cp3 = store.updateReceivedSequence('sess_1', 3);
    expect(cp3.lastReceivedSequence).toBe(10);
    expect(cp3.eventCount).toBe(3);
  });

  test('updateSentSequence tracks sent progress', () => {
    store = createCheckpointStore();
    store.create({
      sessionId: 'sess_1',
      gatewayId: 'gw_1',
      adapterId: 'mock',
      projectId: 'proj_1',
    });

    store.updateSentSequence('sess_1', 7);
    const gap = store.getEventGap('sess_1');
    expect(gap.lastSent).toBe(7);
    expect(gap.lastReceived).toBe(-1);
    expect(gap.gap).toBe(-8);

    store.updateReceivedSequence('sess_1', 15);
    const gap2 = store.getEventGap('sess_1');
    expect(gap2.gap).toBe(8); // 15 - 7
  });

  test('updateEventTypeOffset tracks per-type sequences', () => {
    store = createCheckpointStore();
    store.create({
      sessionId: 'sess_1',
      gatewayId: 'gw_1',
      adapterId: 'mock',
      projectId: 'proj_1',
    });

    store.updateEventTypeOffset('sess_1', 'session.tool_call', 3);
    store.updateEventTypeOffset('sess_1', 'session.tool_call', 7);
    store.updateEventTypeOffset('sess_1', 'session.tool_call', 5); // lower, should not update

    const cp = store.get('sess_1')!;
    expect(cp.eventTypeOffsets['session.tool_call']).toBe(7);
  });

  test('updateSessionState changes state', () => {
    store = createCheckpointStore();
    store.create({
      sessionId: 'sess_1',
      gatewayId: 'gw_1',
      adapterId: 'mock',
      projectId: 'proj_1',
    });

    store.updateSessionState('sess_1', 'running');
    expect(store.get('sess_1')!.sessionState).toBe('running');

    store.updateSessionState('sess_1', 'waiting_for_approval');
    expect(store.get('sess_1')!.sessionState).toBe('waiting_for_approval');
  });

  test('updateReconnectState tracks reconnect lifecycle', () => {
    store = createCheckpointStore();
    store.create({
      sessionId: 'sess_1',
      gatewayId: 'gw_1',
      adapterId: 'mock',
      projectId: 'proj_1',
    });

    store.updateReconnectState('sess_1', 'connected');
    let cp = store.get('sess_1')!;
    expect(cp.reconnectState).toBe('connected');
    expect(cp.reconnectCount).toBe(0);

    store.updateReconnectState('sess_1', 'disconnected');
    cp = store.get('sess_1')!;
    expect(cp.reconnectState).toBe('disconnected');

    store.updateReconnectState('sess_1', 'reconnecting');
    cp = store.get('sess_1')!;
    expect(cp.reconnectState).toBe('reconnecting');
    expect(cp.reconnectCount).toBe(1);

    store.updateReconnectState('sess_1', 'degraded');
    cp = store.get('sess_1')!;
    expect(cp.reconnectState).toBe('degraded');
    expect(cp.failedReconnectAttempts).toBe(1);

    store.updateReconnectState('sess_1', 'reconnecting');
    store.updateReconnectState('sess_1', 'connected');
    cp = store.get('sess_1')!;
    expect(cp.failedReconnectAttempts).toBe(0);
    expect(cp.needsReconciliation).toBe(false);
  });

  test('markNeedsReconciliation sets flag', () => {
    store = createCheckpointStore();
    store.create({
      sessionId: 'sess_1',
      gatewayId: 'gw_1',
      adapterId: 'mock',
      projectId: 'proj_1',
    });

    store.markNeedsReconciliation('sess_1');
    expect(store.get('sess_1')!.needsReconciliation).toBe(true);
  });

  test('pending ack events track and clear', () => {
    store = createCheckpointStore();
    store.create({
      sessionId: 'sess_1',
      gatewayId: 'gw_1',
      adapterId: 'mock',
      projectId: 'proj_1',
    });

    store.addPendingAck('sess_1', 5);
    store.addPendingAck('sess_1', 3);
    store.addPendingAck('sess_1', 7);
    store.addPendingAck('sess_1', 5); // duplicate

    const gap = store.getEventGap('sess_1');
    expect(gap.pendingAcks).toEqual([3, 5, 7]);

    store.ackEvents('sess_1', 5);
    const gap2 = store.getEventGap('sess_1');
    expect(gap2.pendingAcks).toEqual([7]);
  });

  test('markTerminal sets endedAt', () => {
    store = createCheckpointStore();
    store.create({
      sessionId: 'sess_1',
      gatewayId: 'gw_1',
      adapterId: 'mock',
      projectId: 'proj_1',
    });

    store.markTerminal('sess_1', 'completed');
    const cp = store.get('sess_1')!;
    expect(cp.sessionState).toBe('completed');
    expect(cp.endedAt).toBeInstanceOf(Date);
    expect(cp.reconnectState).toBe('idle');
  });

  test('setError records error on checkpoint', () => {
    store = createCheckpointStore();
    store.create({
      sessionId: 'sess_1',
      gatewayId: 'gw_1',
      adapterId: 'mock',
      projectId: 'proj_1',
    });

    store.setError('sess_1', {
      code: 'TIMEOUT',
      message: 'Session timed out',
      fatal: false,
    });

    const cp = store.get('sess_1')!;
    expect(cp.error).toEqual({
      code: 'TIMEOUT',
      message: 'Session timed out',
      fatal: false,
    });
  });

  test('setMetadata stores arbitrary data', () => {
    store = createCheckpointStore();
    store.create({
      sessionId: 'sess_1',
      gatewayId: 'gw_1',
      adapterId: 'mock',
      projectId: 'proj_1',
    });

    store.setMetadata('sess_1', 'customKey', { nested: true });
    expect(store.get('sess_1')!.metadata.customKey).toEqual({ nested: true });
  });

  test('delete removes checkpoint', () => {
    store = createCheckpointStore();
    store.create({
      sessionId: 'sess_1',
      gatewayId: 'gw_1',
      adapterId: 'mock',
      projectId: 'proj_1',
    });

    expect(store.get('sess_1')).toBeDefined();
    const deleted = store.delete('sess_1');
    expect(deleted).toBe(true);
    expect(store.get('sess_1')).toBeUndefined();
  });

  test('list and filter active checkpoints', () => {
    store = createCheckpointStore();
    store.create({ sessionId: 's1', gatewayId: 'gw_1', adapterId: 'mock', projectId: 'p1' });
    store.create({ sessionId: 's2', gatewayId: 'gw_1', adapterId: 'mock', projectId: 'p1' });
    store.create({ sessionId: 's3', gatewayId: 'gw_1', adapterId: 'mock', projectId: 'p1' });

    store.markTerminal('s2', 'completed');

    expect(store.list()).toHaveLength(3);
    expect(store.listActive()).toHaveLength(2);
    expect(store.listActive().map((cp) => cp.sessionId)).not.toContain('s2');
  });

  test('listNeedingReconciliation returns flagged checkpoints', () => {
    store = createCheckpointStore();
    store.create({ sessionId: 's1', gatewayId: 'gw_1', adapterId: 'mock', projectId: 'p1' });
    store.create({ sessionId: 's2', gatewayId: 'gw_1', adapterId: 'mock', projectId: 'p1' });

    store.markNeedsReconciliation('s1');

    expect(store.listNeedingReconciliation()).toHaveLength(1);
    expect(store.listNeedingReconciliation()[0]!.sessionId).toBe('s1');
  });

  test('getStats returns accurate counts', () => {
    store = createCheckpointStore();
    store.create({ sessionId: 's1', gatewayId: 'gw_1', adapterId: 'mock', projectId: 'p1' });
    store.create({ sessionId: 's2', gatewayId: 'gw_1', adapterId: 'mock', projectId: 'p1' });
    store.markTerminal('s1', 'completed');

    const stats = store.getStats();
    expect(stats.totalCheckpoints).toBe(2);
    expect(stats.activeCheckpoints).toBe(1);
    expect(stats.terminalCheckpoints).toBe(1);
    expect(stats.lastPersistedAt).toBeInstanceOf(Date);
  });

  test('clear removes all checkpoints', () => {
    store = createCheckpointStore();
    store.create({ sessionId: 's1', gatewayId: 'gw_1', adapterId: 'mock', projectId: 'p1' });
    store.create({ sessionId: 's2', gatewayId: 'gw_1', adapterId: 'mock', projectId: 'p1' });

    store.clear();
    expect(store.list()).toHaveLength(0);
  });

  test('cleanup removes old terminal checkpoints', async () => {
    store = createCheckpointStore({ terminalCheckpointMaxAgeMs: 100 });
    store.create({ sessionId: 's1', gatewayId: 'gw_1', adapterId: 'mock', projectId: 'p1' });
    store.create({ sessionId: 's2', gatewayId: 'gw_1', adapterId: 'mock', projectId: 'p1' });

    store.markTerminal('s1', 'completed');
    store.updateSessionState('s2', 'running');

    // Wait for the terminal checkpoint to age out
    await new Promise((r) => setTimeout(r, 150));

    const cleaned = await store.cleanup();
    expect(cleaned).toBe(1);
    expect(store.get('s1')).toBeUndefined();
    expect(store.get('s2')).toBeDefined();
  });

  test('enforceMaxCheckpoints evicts oldest terminal', () => {
    store = createCheckpointStore({ maxCheckpoints: 3 });
    store.create({ sessionId: 's1', gatewayId: 'gw_1', adapterId: 'mock', projectId: 'p1' });
    store.create({ sessionId: 's2', gatewayId: 'gw_1', adapterId: 'mock', projectId: 'p1' });
    store.markTerminal('s1', 'completed');
    store.markTerminal('s2', 'failed');

    // This should trigger eviction of the oldest terminal
    store.create({ sessionId: 's3', gatewayId: 'gw_1', adapterId: 'mock', projectId: 'p1' });

    // Now adding s4 should cause eviction
    store.create({ sessionId: 's4', gatewayId: 'gw_1', adapterId: 'mock', projectId: 'p1' });

    // s1 (oldest terminal) should be evicted
    expect(store.list()).toHaveLength(3);
  });
});

describe('CheckpointStore - File Persistence', () => {
  let store: CheckpointStore;
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'freebuff-chk-persist-'));
  });

  afterEach(async () => {
    await store.shutdown().catch(() => {});
    try {
      await fs.rm(tempDir, { recursive: true, force: true });
    } catch {
      // swallow
    }
  });

  test('initialize loads persisted checkpoints', async () => {
    // Create and persist a checkpoint
    store = createCheckpointStore({ persistDir: tempDir, autoPersistIntervalMs: 0 });
    await store.initialize();

    store.create({
      sessionId: 'sess_persist1',
      gatewayId: 'gw_1',
      adapterId: 'mock',
      projectId: 'proj_1',
    });
    store.updateSessionState('sess_persist1', 'running');
    await store.persistAll();

    // Create a new store and verify it loads the checkpoint
    const store2 = createCheckpointStore({ persistDir: tempDir, autoPersistIntervalMs: 0 });
    await store2.initialize();

    const cp = store2.get('sess_persist1');
    expect(cp).toBeDefined();
    expect(cp!.sessionState).toBe('running');
    expect(cp!.sessionId).toBe('sess_persist1');

    await store2.shutdown();
  });

  test('persistOne writes checkpoint to disk', async () => {
    store = createCheckpointStore({ persistDir: tempDir, autoPersistIntervalMs: 0 });
    await store.initialize();

    store.create({
      sessionId: 'sess_test',
      gatewayId: 'gw_1',
      adapterId: 'mock',
      projectId: 'proj_1',
    });
    await store.persistOne('sess_test');

    const filename = path.join(tempDir, 'sess_test.checkpoint.json');
    const content = await fs.readFile(filename, 'utf-8');
    const data = JSON.parse(content) as { sessionId: string; gatewayId: string };
    expect(data.sessionId).toBe('sess_test');
    expect(data.gatewayId).toBe('gw_1');
  });

  test('persistAll writes all checkpoints', async () => {
    store = createCheckpointStore({ persistDir: tempDir, autoPersistIntervalMs: 0 });
    await store.initialize();

    store.create({ sessionId: 's1', gatewayId: 'gw_1', adapterId: 'mock', projectId: 'p1' });
    store.create({ sessionId: 's2', gatewayId: 'gw_1', adapterId: 'mock', projectId: 'p1' });

    const count = await store.persistAll();
    expect(count).toBe(2);

    const files = await fs.readdir(tempDir);
    const checkpointFiles = files.filter((f) => f.endsWith('.checkpoint.json'));
    expect(checkpointFiles).toHaveLength(2);
  });

  test('persistAll cleans up deleted checkpoint files', async () => {
    store = createCheckpointStore({ persistDir: tempDir, autoPersistIntervalMs: 0 });
    await store.initialize();

    store.create({ sessionId: 's1', gatewayId: 'gw_1', adapterId: 'mock', projectId: 'p1' });
    await store.persistAll();

    // Delete the checkpoint
    store.delete('s1');
    const count = await store.persistAll();
    expect(count).toBe(0);

    // File should be cleaned up
    const files = await fs.readdir(tempDir);
    const checkpointFiles = files.filter((f) => f.endsWith('.checkpoint.json'));
    expect(checkpointFiles).toHaveLength(0);
  });

  test('store without persistDir works in-memory only', async () => {
    store = createCheckpointStore({ autoPersistIntervalMs: 0 });
    await store.initialize();

    store.create({ sessionId: 's1', gatewayId: 'gw_1', adapterId: 'mock', projectId: 'p1' });
    await store.persistAll(); // should be no-op

    expect(store.get('s1')).toBeDefined();
  });
});
