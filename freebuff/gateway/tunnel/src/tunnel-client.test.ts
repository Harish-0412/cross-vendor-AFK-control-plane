import { describe, test, expect, afterEach } from 'vitest';

import { createTunnelClient, type TunnelClient } from '../src/tunnel-client';
import type { TunnelEvent, TunnelState } from '../src/types';

describe('TunnelClient', () => {
  let client: TunnelClient;

  afterEach(async () => {
    await client.shutdown().catch(() => {});
  });

  const baseConfig = {
    controlPlaneUrl: 'wss://control.example.com/tunnel',
    deviceId: 'dev_test123',
    gatewayId: 'gw_test123',
  };

  test('creates with correct initial state', () => {
    client = createTunnelClient(baseConfig);

    expect(client.getState()).toBe('idle');
    expect(client.isConnected()).toBe(false);
    expect(client.getDeviceId()).toBe('dev_test123');
    expect(client.getGatewayId()).toBe('gw_test123');
  });

  test('connect transitions to connected state', async () => {
    client = createTunnelClient(baseConfig);

    await client.connect();
    expect(client.getState()).toBe('connected');
    expect(client.isConnected()).toBe(true);
  });

  test('connect is idempotent when already connected', async () => {
    client = createTunnelClient(baseConfig);

    await client.connect();
    await client.connect(); // should not throw
    expect(client.getState()).toBe('connected');
  });

  test('disconnect transitions to disconnected', async () => {
    client = createTunnelClient(baseConfig);

    await client.connect();
    expect(client.getState()).toBe('connected');

    await client.disconnect();
    expect(client.getState()).toBe('disconnected');
    expect(client.isConnected()).toBe(false);
  });

  test('disconnect is idempotent when already disconnected', async () => {
    client = createTunnelClient(baseConfig);

    await client.connect();
    await client.disconnect();
    expect(client.getState()).toBe('disconnected');

    await client.disconnect(); // should not throw
    expect(client.getState()).toBe('disconnected');
  });

  test('send queues messages when disconnected', () => {
    client = createTunnelClient(baseConfig);

    const msg = client.send('event', { type: 'test', data: 'hello' });
    expect(msg.id).toMatch(/^msg_/);
    expect(msg.type).toBe('event');
    expect(msg.sequence).toBe(1);
    expect(msg.timestamp).toBeInstanceOf(Date);

    const queued = client.getQueuedMessages();
    expect(queued).toHaveLength(1);
    expect(queued[0]!.id).toBe(msg.id);
  });

  test('send records sent messages when connected', async () => {
    client = createTunnelClient(baseConfig);

    await client.connect();
    client.send('event', { data: 'hello' });
    client.send('heartbeat', { ts: Date.now() });

    const stats = client.getStats();
    expect(stats.messagesSent).toBe(2);
    expect(stats.messagesQueued).toBe(0);
    expect(stats.bytesSent).toBeGreaterThan(0);
    expect(stats.lastSentAt).toBeInstanceOf(Date);
  });

  test('flushQueue sends all queued messages', async () => {
    client = createTunnelClient(baseConfig);

    // Queue while disconnected
    client.send('event', { data: '1' });
    client.send('event', { data: '2' });
    client.send('event', { data: '3' });

    expect(client.getQueuedMessages()).toHaveLength(3);

    // Connecting drains the backlog on its own — that is what the queue is for.
    await client.connect();

    expect(client.getQueuedMessages()).toHaveLength(0);
    expect(client.getStats().messagesSent).toBe(3);

    // Nothing is left, so an explicit flush is a no-op rather than a resend.
    await expect(client.flushQueue()).resolves.toBe(0);
    expect(client.getStats().messagesSent).toBe(3);
  });

  test('flushQueue terminates when connected without a usable socket', async () => {
    // Regression: flushQueue used to shift a message off the queue and
    // sendMessageOverWire pushed it straight back whenever the socket was not
    // open, so the loop never terminated. That state — marked connected, no
    // usable socket — is precisely the degraded window this client has to
    // survive, and hitting it pinned a core and hung the process.
    client = createTunnelClient(baseConfig);
    await client.connect();

    // Force the "connected but nothing to write to" condition.
    (client as unknown as { ws: unknown }).ws = { readyState: 3, send() {}, close() {} };
    (client as unknown as { WebSocketImpl: unknown }).WebSocketImpl = class {};

    client.send('event', { data: 'stuck' });

    const flushed = await Promise.race([
      client.flushQueue(),
      new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error('flushQueue did not terminate')), 2000),
      ),
    ]);

    expect(flushed).toBe(0);
    // The message is retained rather than dropped or infinitely retried.
    expect(client.getQueuedMessages()).toHaveLength(1);
  });

  test('flushQueue returns 0 when disconnected', async () => {
    client = createTunnelClient(baseConfig);

    client.send('event', { data: '1' });
    const flushed = await client.flushQueue();
    expect(flushed).toBe(0);
    expect(client.getQueuedMessages()).toHaveLength(1);
  });

  test('clearQueue removes all queued messages', () => {
    client = createTunnelClient(baseConfig);

    client.send('event', { data: '1' });
    client.send('event', { data: '2' });

    const cleared = client.clearQueue();
    expect(cleared).toBe(2);
    expect(client.getQueuedMessages()).toHaveLength(0);
  });

  test('queue overflow drops oldest messages', async () => {
    client = createTunnelClient({
      ...baseConfig,
      maxQueueSize: 5,
    });

    for (let i = 0; i < 8; i++) {
      client.send('event', { index: i });
    }

    const queued = client.getQueuedMessages();
    expect(queued).toHaveLength(5);
    // The oldest 3 should be dropped
    expect(queued[0]!.payload).toEqual({ index: 3 });
  });

  test('handleIncoming records received message', () => {
    client = createTunnelClient(baseConfig);

    client.handleIncoming({
      id: 'msg_test',
      type: 'command',
      sequence: 1,
      timestamp: new Date(),
      payload: { action: 'start' },
    });

    const stats = client.getStats();
    expect(stats.messagesReceived).toBe(1);
    expect(stats.bytesReceived).toBeGreaterThan(0);
    expect(stats.lastReceivedAt).toBeInstanceOf(Date);
  });

  test('setAuthToken updates the token', () => {
    client = createTunnelClient({ ...baseConfig, authToken: 'old-token' });
    client.setAuthToken('new-token');
    // Token is internal; verify no error
    expect(() => client.setAuthToken('refreshed-token')).not.toThrow();
  });

  test('onEvent listener receives events', async () => {
    client = createTunnelClient(baseConfig);

    const events: TunnelEvent[] = [];
    client.onEvent((e) => events.push(e));

    await client.connect();

    expect(events.length).toBeGreaterThanOrEqual(1);
    expect(events.some((e) => e.type === 'state_change')).toBe(true);
    expect(events.some((e) => e.state === 'connected')).toBe(true);
  });

  test('onEvent returns unsubscribe function', async () => {
    client = createTunnelClient(baseConfig);

    const events: TunnelEvent[] = [];
    const unsub = client.onEvent((e) => events.push(e));

    await client.connect();
    expect(events.length).toBeGreaterThan(0);

    const countBefore = events.length;
    unsub();

    await client.disconnect();
    // No new events should have been received after unsubscribe
    expect(events.length).toBe(countBefore);
  });

  test('getStats returns correct shape', () => {
    client = createTunnelClient(baseConfig);

    const stats = client.getStats();
    expect(stats.state).toBe('idle');
    expect(stats.messagesSent).toBe(0);
    expect(stats.messagesReceived).toBe(0);
    expect(stats.messagesQueued).toBe(0);
    expect(stats.reconnectAttempts).toBe(0);
    expect(stats.bytesSent).toBe(0);
    expect(stats.bytesReceived).toBe(0);
    expect(stats.uptimeMs).toBe(0);
    expect(stats.disconnectedTimeMs).toBe(0);
  });

  test('getStats tracks uptime when connected', async () => {
    client = createTunnelClient(baseConfig);

    await client.connect();
    await new Promise((r) => setTimeout(r, 100));

    const stats = client.getStats();
    expect(stats.uptimeMs).toBeGreaterThan(0);
    expect(stats.connectedAt).toBeInstanceOf(Date);
  });

  test('sequence numbers are monotonically increasing', () => {
    client = createTunnelClient(baseConfig);

    const msg1 = client.send('event', { n: 1 });
    const msg2 = client.send('event', { n: 2 });
    const msg3 = client.send('event', { n: 3 });

    expect(msg2.sequence).toBeGreaterThan(msg1.sequence);
    expect(msg3.sequence).toBeGreaterThan(msg2.sequence);
  });

  test('message with correlationId is preserved', () => {
    client = createTunnelClient(baseConfig);

    const msg = client.send('command', { action: 'test' }, 'corr_abc');
    expect(msg.correlationId).toBe('corr_abc');
  });

  test('shutdown cleans up everything', async () => {
    client = createTunnelClient(baseConfig);

    await client.connect();
    client.send('event', { data: 'queued' });

    await client.shutdown();

    expect(client.getQueuedMessages()).toHaveLength(0);
    // After shutdown, state should not change
    const state = client.getState();
    expect(['disconnected', 'idle']).toContain(state);
  });

  test('multiple connect/disconnect cycles work', async () => {
    client = createTunnelClient(baseConfig);

    for (let i = 0; i < 3; i++) {
      await client.connect();
      expect(client.isConnected()).toBe(true);

      client.send('event', { cycle: i });
      await client.flushQueue();

      await client.disconnect();
      expect(client.isConnected()).toBe(false);
    }

    const stats = client.getStats();
    expect(stats.messagesSent).toBe(3);
  });
});
