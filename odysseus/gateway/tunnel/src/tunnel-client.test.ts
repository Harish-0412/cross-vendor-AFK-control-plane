import { describe, test, expect, afterEach } from 'vitest';

import { createTunnelClient, type TunnelClient } from '../src/tunnel-client';
import type { TunnelEvent } from '../src/types';

/**
 * A fake WebSocket that completes the handshake in-process.
 *
 * The client used to fake a connection itself when no implementation was
 * supplied; that stub is gone, because a transport that pretends to be
 * connected hides real outages. Tests now inject this instead, which also
 * means they exercise the same code path production does.
 */
class MockWebSocket {
  static instances: MockWebSocket[] = [];

  readyState = 0;
  onopen: ((event: unknown) => void) | null = null;
  onmessage: ((event: { data: unknown }) => void) | null = null;
  onclose:
    | ((event: { code: number; reason: string; wasClean: boolean }) => void)
    | null = null;
  onerror: ((event: unknown) => void) | null = null;
  readonly sent: string[] = [];

  constructor(readonly url: string) {
    MockWebSocket.instances.push(this);
    // Open on the next tick so `connect()` has installed its handlers.
    setTimeout(() => {
      this.readyState = 1;
      this.onopen?.({});
    }, 0);
  }

  send(data: string | Uint8Array): void {
    const text = typeof data === 'string' ? data : new TextDecoder().decode(data);
    this.sent.push(text);

    // The server answers an auth message with auth_success, as the real
    // Control Plane does for a trusted device.
    try {
      const message = JSON.parse(text) as { id?: string; type?: string };
      if (message.type === 'auth') {
        setTimeout(() => {
          this.emit({
            id: 'srv_auth_ok',
            type: 'auth_success',
            sequence: 1,
            correlationId: message.id,
            timestamp: new Date().toISOString(),
            payload: {
              sessionId: 'cpsess_mock',
              assignedGlobalSequence: 0,
              serverTimestamp: new Date().toISOString(),
              capabilities: ['sessions'],
            },
          });
        }, 0);
      }
    } catch {
      /* non-JSON frames are not interesting to these tests */
    }
  }

  emit(message: Record<string, unknown>): void {
    this.onmessage?.({ data: JSON.stringify(message) });
  }

  close(code = 1000, reason = ''): void {
    this.readyState = 3;
    this.onclose?.({ code, reason, wasClean: code === 1000 });
  }
}

/** Resolves once `predicate` holds, so tests do not race the mock's timers. */
async function waitFor(predicate: () => boolean, timeoutMs = 2000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error(`Condition not met within ${timeoutMs}ms`);
}

describe('TunnelClient', () => {
  let client: TunnelClient;

  afterEach(async () => {
    await client.shutdown().catch(() => {});
    MockWebSocket.instances = [];
  });

  const baseConfig = {
    controlPlaneUrl: 'wss://control.example.com/tunnel',
    deviceId: 'dev_test123',
    gatewayId: 'gw_test123',
  };

  /** A client wired to the mock transport. */
  function makeClient(
    overrides: Partial<typeof baseConfig> & Record<string, unknown> = {},
  ): TunnelClient {
    const c = createTunnelClient({ ...baseConfig, ...overrides });
    c.setWebSocketImplementation(MockWebSocket as never);
    return c;
  }

  /**
   * Connect and give the handshake a moment to land. The auth round trip is
   * asynchronous, so `await connect()` alone only guarantees the socket opened.
   * Tolerant by design: tests that expect a failure assert it themselves.
   */
  async function connectAndSettle(c: TunnelClient): Promise<void> {
    await c.connect();
    try {
      await waitFor(() => c.getState() === 'connected', 1000);
    } catch {
      /* the test makes its own assertion about the resulting state */
    }
  }

  test('creates with correct initial state', () => {
    client = makeClient();

    expect(client.getState()).toBe('idle');
    expect(client.isConnected()).toBe(false);
    expect(client.getDeviceId()).toBe('dev_test123');
    expect(client.getGatewayId()).toBe('gw_test123');
  });

  test('connect transitions to connected state', async () => {
    client = makeClient();

    await connectAndSettle(client);
    expect(client.getState()).toBe('connected');
    expect(client.isConnected()).toBe(true);
  });

  test('connect is idempotent when already connected', async () => {
    client = makeClient();

    await connectAndSettle(client);
    await connectAndSettle(client); // should not throw
    expect(client.getState()).toBe('connected');
  });

  test('disconnect transitions to disconnected', async () => {
    client = makeClient();

    await connectAndSettle(client);
    expect(client.getState()).toBe('connected');

    await client.disconnect();
    expect(client.getState()).toBe('disconnected');
    expect(client.isConnected()).toBe(false);
  });

  test('disconnect is idempotent when already disconnected', async () => {
    client = makeClient();

    await connectAndSettle(client);
    await client.disconnect();
    expect(client.getState()).toBe('disconnected');

    await client.disconnect(); // should not throw
    expect(client.getState()).toBe('disconnected');
  });

  test('send queues messages when disconnected', () => {
    client = makeClient();

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
    client = makeClient();

    await connectAndSettle(client);
    client.send('event', { data: 'hello' });
    client.send('heartbeat', { ts: Date.now() });

    const stats = client.getStats();
    // auth handshake + the two messages sent above
    expect(stats.messagesSent).toBe(3);
    expect(stats.messagesQueued).toBe(0);
    expect(stats.bytesSent).toBeGreaterThan(0);
    expect(stats.lastSentAt).toBeInstanceOf(Date);
  });

  test('flushQueue sends all queued messages', async () => {
    client = makeClient();

    // Queue while disconnected
    client.send('event', { data: '1' });
    client.send('event', { data: '2' });
    client.send('event', { data: '3' });

    expect(client.getQueuedMessages()).toHaveLength(3);

    // Connecting drains the backlog on its own — that is what the queue is for.
    await connectAndSettle(client);

    expect(client.getQueuedMessages()).toHaveLength(0);
    // auth handshake + the three queued messages
    expect(client.getStats().messagesSent).toBe(4);

    // Nothing is left, so an explicit flush is a no-op rather than a resend.
    await expect(client.flushQueue()).resolves.toBe(0);
    expect(client.getStats().messagesSent).toBe(4);
  });

  test('flushQueue terminates when connected without a usable socket', async () => {
    // Regression: flushQueue used to shift a message off the queue and
    // sendMessageOverWire pushed it straight back whenever the socket was not
    // open, so the loop never terminated. That state — marked connected, no
    // usable socket — is precisely the degraded window this client has to
    // survive, and hitting it pinned a core and hung the process.
    client = makeClient();
    await connectAndSettle(client);

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
    client = makeClient();

    client.send('event', { data: '1' });
    const flushed = await client.flushQueue();
    expect(flushed).toBe(0);
    expect(client.getQueuedMessages()).toHaveLength(1);
  });

  test('clearQueue removes all queued messages', () => {
    client = makeClient();

    client.send('event', { data: '1' });
    client.send('event', { data: '2' });

    const cleared = client.clearQueue();
    expect(cleared).toBe(2);
    expect(client.getQueuedMessages()).toHaveLength(0);
  });

  test('queue overflow drops oldest messages', async () => {
    client = makeClient({
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
    client = makeClient();

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
    client = makeClient({ ...baseConfig, authToken: 'old-token' });
    client.setAuthToken('new-token');
    // Token is internal; verify no error
    expect(() => client.setAuthToken('refreshed-token')).not.toThrow();
  });

  test('onEvent listener receives events', async () => {
    client = makeClient();

    const events: TunnelEvent[] = [];
    client.onEvent((e) => events.push(e));

    await connectAndSettle(client);

    expect(events.length).toBeGreaterThanOrEqual(1);
    expect(events.some((e) => e.type === 'state_change')).toBe(true);
    expect(events.some((e) => e.state === 'connected')).toBe(true);
  });

  test('onEvent returns unsubscribe function', async () => {
    client = makeClient();

    const events: TunnelEvent[] = [];
    const unsub = client.onEvent((e) => events.push(e));

    await connectAndSettle(client);
    expect(events.length).toBeGreaterThan(0);

    const countBefore = events.length;
    unsub();

    await client.disconnect();
    // No new events should have been received after unsubscribe
    expect(events.length).toBe(countBefore);
  });

  test('getStats returns correct shape', () => {
    client = makeClient();

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
    client = makeClient();

    await connectAndSettle(client);
    await new Promise((r) => setTimeout(r, 100));

    const stats = client.getStats();
    expect(stats.uptimeMs).toBeGreaterThan(0);
    expect(stats.connectedAt).toBeInstanceOf(Date);
  });

  test('sequence numbers are monotonically increasing', () => {
    client = makeClient();

    const msg1 = client.send('event', { n: 1 });
    const msg2 = client.send('event', { n: 2 });
    const msg3 = client.send('event', { n: 3 });

    expect(msg2.sequence).toBeGreaterThan(msg1.sequence);
    expect(msg3.sequence).toBeGreaterThan(msg2.sequence);
  });

  test('message with correlationId is preserved', () => {
    client = makeClient();

    const msg = client.send('command', { action: 'test' }, 'corr_abc');
    expect(msg.correlationId).toBe('corr_abc');
  });

  test('shutdown cleans up everything', async () => {
    client = makeClient();

    await connectAndSettle(client);
    client.send('event', { data: 'queued' });

    await client.shutdown();

    expect(client.getQueuedMessages()).toHaveLength(0);
    // After shutdown, state should not change
    const state = client.getState();
    expect(['disconnected', 'idle']).toContain(state);
  });

  test('multiple connect/disconnect cycles work', async () => {
    client = makeClient();

    for (let i = 0; i < 3; i++) {
      await connectAndSettle(client);
      expect(client.isConnected()).toBe(true);

      client.send('event', { cycle: i });
      await client.flushQueue();

      await client.disconnect();
      expect(client.isConnected()).toBe(false);
    }

    // Each cycle now performs a real handshake, so messagesSent counts an
    // `auth` frame per cycle as well as the event. Assert on the frames that
    // carry payload rather than on the raw total, which conflates the two.
    const framesByType = MockWebSocket.instances
      .flatMap((socket) => socket.sent)
      .map((raw) => (JSON.parse(raw) as { type: string }).type);

    expect(framesByType.filter((type) => type === 'event')).toHaveLength(3);
    expect(framesByType.filter((type) => type === 'auth')).toHaveLength(3);
    // 3 cycles x (auth + event + disconnect)
    expect(framesByType.filter((type) => type === 'disconnect')).toHaveLength(3);
    expect(client.getStats().messagesSent).toBe(9);
  });

  // --- PR 4: failure taxonomy --------------------------------------------

  test('a revoked device stops permanently and never reconnects', async () => {
    client = makeClient();
    await client.connect();
    await waitFor(() => MockWebSocket.instances.length > 0);

    const socket = MockWebSocket.instances[0]!;
    socket.emit({
      id: 'srv_1',
      type: 'auth_failure',
      sequence: 1,
      timestamp: new Date().toISOString(),
      payload: {
        code: 'DEVICE_REVOKED',
        reason: 'Device status is revoked',
        retryable: false,
      },
    });

    await waitFor(() => client.getState() === 'error');

    const failure = client.getLastFailure();
    expect(failure?.class).toBe('auth_fatal');
    expect(failure?.retryable).toBe(false);

    // No new socket was opened: a revoked device must not retry.
    const socketCount = MockWebSocket.instances.length;
    await new Promise((resolve) => setTimeout(resolve, 200));
    expect(MockWebSocket.instances.length).toBe(socketCount);
  });

  test('a device awaiting pairing approval is retryable, not fatal', async () => {
    client = makeClient();
    await client.connect();
    await waitFor(() => MockWebSocket.instances.length > 0);

    MockWebSocket.instances[0]!.emit({
      id: 'srv_1',
      type: 'auth_failure',
      sequence: 1,
      timestamp: new Date().toISOString(),
      payload: {
        code: 'DEVICE_NOT_TRUSTED',
        reason: 'Device is not yet paired or trusted by a user',
        retryable: true,
      },
    });

    await waitFor(() => client.getLastFailure() !== null);
    const failure = client.getLastFailure();
    expect(failure?.class).toBe('auth_retryable');
    expect(failure?.retryable).toBe(true);
    // Slow retry: a human has to approve in the UI, so do not spin.
    expect(failure?.retryAfterMs).toBeGreaterThanOrEqual(30_000);
  });

  test('an unrecognised auth failure is treated as fatal rather than retried blindly', async () => {
    client = makeClient();
    await client.connect();
    await waitFor(() => MockWebSocket.instances.length > 0);

    MockWebSocket.instances[0]!.emit({
      id: 'srv_1',
      type: 'auth_failure',
      sequence: 1,
      timestamp: new Date().toISOString(),
      payload: { code: 'SOMETHING_NEW', reason: 'unknown', retryable: false },
    });

    await waitFor(() => client.getLastFailure() !== null);
    expect(client.getLastFailure()?.class).toBe('auth_fatal');
  });

  // --- PR 4: transport honesty -------------------------------------------

  test('connecting without a WebSocket implementation fails loudly', async () => {
    client = createTunnelClient(baseConfig); // deliberately no mock injected

    await client.connect();

    // It must NOT report connected. The old stub simulated a connection here,
    // which meant a misconfigured gateway believed it was online.
    expect(client.isConnected()).toBe(false);
    expect(client.getState()).not.toBe('connected');
  });

  // --- PR 4: backoff defaults --------------------------------------------

  test('reconnect attempts are unlimited by default', () => {
    client = makeClient();
    // -1 means unbounded: a laptop that sleeps through an outage must still
    // come back, rather than waking up permanently disconnected.
    expect(client.getConfig().maxReconnectAttempts).toBe(-1);
  });

  test('backoff is not reset until the connection has proven healthy', async () => {
    client = makeClient({ healthyConnectionMs: 10_000 });
    await connectAndSettle(client);

    // Connected, but not yet healthy for long enough, so a prior backoff would
    // still be in force. The counter is only cleared by the healthy timer.
    expect(client.getStats().reconnectAttempts).toBe(0);
    expect(client.isConnected()).toBe(true);
  });
});
