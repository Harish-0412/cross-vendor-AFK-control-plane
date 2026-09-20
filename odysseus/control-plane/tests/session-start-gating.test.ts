import { describe, test, expect, beforeEach } from 'vitest';

import { MemoryDatabase } from '../src/db/memory-store';
import { ConnectionRegistry } from '../src/tunnel/connection-registry';
import { TunnelServer } from '../src/tunnel/tunnel-server';

/**
 * M1 acceptance: an ack means the gateway received the start command, not that
 * the adapter launched. A session becomes `running` only on a real
 * `session.started` event — otherwise a session that failed to launch is
 * indistinguishable from one that is working, which is exactly the false-green
 * this gating removes.
 */
describe('session start gating', () => {
  let db: MemoryDatabase;
  let registry: ConnectionRegistry;
  let tunnel: TunnelServer;

  beforeEach(() => {
    db = new MemoryDatabase();
    registry = new ConnectionRegistry();
    tunnel = new TunnelServer(db, registry);
  });

  test('a start that is never confirmed times out rather than reporting running', async () => {
    const outcome = await tunnel.waitForSessionStart('sess_never_starts', 150);

    expect(outcome.started).toBe(false);
    expect(outcome.timedOut).toBe(true);
    expect(outcome.error).toMatch(/never reported session\.started/);
  });

  test('a session.started event resolves the wait as started', async () => {
    const waiting = tunnel.waitForSessionStart('sess_ok', 5_000);

    // Simulate the gateway reporting that the adapter really started.
    (tunnel as unknown as {
      resolveSessionStart: (id: string, r: { started: boolean }) => void;
    }).resolveSessionStart('sess_ok', { started: true });

    await expect(waiting).resolves.toMatchObject({ started: true });
  });

  test('a failure event resolves the wait as not started, with the reason', async () => {
    const waiting = tunnel.waitForSessionStart('sess_bad', 5_000);

    (tunnel as unknown as {
      resolveSessionStart: (id: string, r: { started: boolean; error: string }) => void;
    }).resolveSessionStart('sess_bad', {
      started: false,
      error: 'adapter exited before producing a result',
    });

    const outcome = await waiting;
    expect(outcome.started).toBe(false);
    expect(outcome.error).toContain('adapter exited');
  });

  test('an event that arrives before anyone waits is not lost', async () => {
    // The gateway can be faster than the HTTP handler; the result is held
    // briefly so the waiter still sees it instead of hanging to its timeout.
    (tunnel as unknown as {
      resolveSessionStart: (id: string, r: { started: boolean }) => void;
    }).resolveSessionStart('sess_fast', { started: true });

    const outcome = await tunnel.waitForSessionStart('sess_fast', 150);
    expect(outcome.started).toBe(true);
    expect(outcome.timedOut).toBeUndefined();
  });

  test('a held result is consumed once, so a second wait times out', async () => {
    (tunnel as unknown as {
      resolveSessionStart: (id: string, r: { started: boolean }) => void;
    }).resolveSessionStart('sess_once', { started: true });

    await expect(tunnel.waitForSessionStart('sess_once', 150)).resolves.toMatchObject({
      started: true,
    });
    await expect(tunnel.waitForSessionStart('sess_once', 150)).resolves.toMatchObject({
      timedOut: true,
    });
  });
});
