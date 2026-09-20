import type { EventEnvelope } from '@odysseus/protocol';
import { describe, test, expect, beforeEach } from 'vitest';

import { MemoryDatabase } from '../src/db/memory-store';
import { ConnectionRegistry } from '../src/tunnel/connection-registry';

const DEVICE = 'dev_multi0001';

/** A socket stub whose open/closed state the test controls. */
function fakeSocket(open = true) {
  return {
    readyState: open ? 1 : 3,
    close() {
      this.readyState = 3;
    },
  } as unknown as Parameters<ConnectionRegistry['registerGateway']>[0]['socket'];
}

function envelope(overrides: Partial<EventEnvelope> = {}): EventEnvelope {
  return {
    eventId: 'evt_fixed_1',
    eventType: 'session.output',
    eventVersion: 1,
    sessionId: 'sess_1',
    deviceId: DEVICE,
    sequence: 1,
    occurredAt: new Date(),
    payload: { stream: 'stdout', content: 'hello' },
    ...overrides,
  } as EventEnvelope;
}

// --- PR 5 --------------------------------------------------------------

describe('event append idempotency', () => {
  let db: MemoryDatabase;

  beforeEach(() => {
    db = new MemoryDatabase();
  });

  async function append(env: EventEnvelope) {
    return db.events.append({
      sessionId: env.sessionId,
      deviceId: DEVICE,
      sequence: env.sequence,
      eventType: env.eventType,
      envelope: env,
    });
  }

  test('re-appending the same event is a no-op', async () => {
    const env = envelope();
    const first = await append(env);
    const second = await append(env);

    expect(second.id).toBe(first.id);
    const stored = await db.events.listBySession('sess_1');
    expect(stored).toHaveLength(1);
  });

  test('replaying a whole batch leaves the count unchanged', async () => {
    const batch = [1, 2, 3, 4, 5].map((n) =>
      envelope({ eventId: `evt_${n}`, sequence: n }),
    );

    for (const env of batch) await append(env);
    expect(await db.events.listBySession('sess_1')).toHaveLength(5);

    // The tunnel replays its queue after a reconnect, and with more than one
    // connection the same event can arrive over either.
    for (const env of batch) await append(env);
    for (const env of batch) await append(env);

    expect(await db.events.listBySession('sess_1')).toHaveLength(5);
  });

  test('distinct events that share a sequence are both kept', async () => {
    // Deduping on (sessionId, sequence) would silently drop one of these.
    // Two counters in the gateway historically both started at zero.
    await append(envelope({ eventId: 'evt_a', sequence: 0, eventType: 'session.created' }));
    await append(envelope({ eventId: 'evt_b', sequence: 0, eventType: 'session.started' }));

    const stored = await db.events.listBySession('sess_1');
    expect(stored).toHaveLength(2);
    expect(stored.map((e) => e.eventType).sort()).toEqual(['session.created', 'session.started']);
  });

  test('highest sequence is unaffected by duplicates', async () => {
    await append(envelope({ eventId: 'evt_1', sequence: 7 }));
    await append(envelope({ eventId: 'evt_1', sequence: 7 }));
    expect(await db.events.getHighestSequence('sess_1')).toBe(7);
  });
});

// --- PR 6 --------------------------------------------------------------

describe('multi-connection registry', () => {
  let registry: ConnectionRegistry;

  beforeEach(() => {
    registry = new ConnectionRegistry();
  });

  function connect(connectionId: string, open = true) {
    const socket = fakeSocket(open);
    registry.registerGateway({
      deviceId: DEVICE,
      gatewayId: 'gw_multi',
      socket,
      connectionId,
      connectedAt: new Date(),
      lastHeartbeatAt: new Date(),
      capabilities: ['sessions'],
    });
    return socket;
  }

  test('a device can hold several connections at once', () => {
    connect('conn-0');
    connect('conn-1');

    expect(registry.countConnections(DEVICE)).toBe(2);
    expect(registry.isDeviceOnline(DEVICE)).toBe(true);
  });

  test('reconnecting the same slot replaces it rather than accumulating', () => {
    connect('conn-0');
    connect('conn-0');
    expect(registry.countConnections(DEVICE)).toBe(1);
  });

  test('losing one connection leaves the device online', () => {
    const first = connect('conn-0');
    connect('conn-1');

    // One socket dies.
    (first as unknown as { readyState: number }).readyState = 3;
    registry.removeGatewaySocket(DEVICE, first);

    expect(registry.countConnections(DEVICE)).toBe(1);
    expect(registry.isDeviceOnline(DEVICE)).toBe(true);
    expect(registry.pickConnection(DEVICE)?.connectionId).toBe('conn-1');
  });

  test('the device goes offline only when the last connection drops', () => {
    const a = connect('conn-0');
    const b = connect('conn-1');

    registry.removeGatewaySocket(DEVICE, a);
    expect(registry.isDeviceOnline(DEVICE)).toBe(true);

    registry.removeGatewaySocket(DEVICE, b);
    expect(registry.isDeviceOnline(DEVICE)).toBe(false);
    expect(registry.countConnections(DEVICE)).toBe(0);
  });

  test('closed sockets are never selected for dispatch', () => {
    connect('conn-0', false); // already closed
    connect('conn-1', true);

    for (let i = 0; i < 5; i++) {
      expect(registry.pickConnection(DEVICE)?.connectionId).toBe('conn-1');
    }
  });

  test('dispatch prefers the least-loaded connection', () => {
    connect('conn-0');
    connect('conn-1');

    const busy = registry
      .listGatewayConnections(DEVICE)
      .find((conn) => conn.connectionId === 'conn-0')!;
    busy.inFlight = 3;

    // conn-1 has no in-flight work, so it wins every time.
    for (let i = 0; i < 4; i++) {
      expect(registry.pickConnection(DEVICE)?.connectionId).toBe('conn-1');
    }
  });

  test('equal load is spread round-robin rather than always hitting the first', () => {
    connect('conn-0');
    connect('conn-1');

    const picks = [0, 1, 2, 3].map(() => registry.pickConnection(DEVICE)?.connectionId);
    expect(new Set(picks).size).toBe(2);
  });

  test('draining reported on one connection applies to the whole device', () => {
    connect('conn-0');
    connect('conn-1');

    registry.setAdmissionPhase(DEVICE, 'draining');

    // The gateway process is shared, so one connection saying "draining" is
    // the truth for every connection it owns.
    expect(registry.getAdmissionPhase(DEVICE)).toBe('draining');
    expect(registry.isDeviceAcceptingSessions(DEVICE)).toBe(false);
    expect(registry.isDeviceOnline(DEVICE)).toBe(true);
  });

  test('a single-connection gateway behaves exactly as before', () => {
    connect('default');
    expect(registry.isDeviceOnline(DEVICE)).toBe(true);
    expect(registry.getGateway(DEVICE)?.connectionId).toBe('default');

    registry.removeGateway(DEVICE);
    expect(registry.isDeviceOnline(DEVICE)).toBe(false);
  });
});
