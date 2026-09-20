import { WebSocket } from 'ws';
import { describe, it, expect, beforeEach, afterEach } from 'vitest';

import { ControlPlane } from '../src/control-plane';

/**
 * The browser WebSocket used to accept a connection with no token at all,
 * registering it as user 'anonymous'. An invalid token was refused; an absent
 * one was welcomed. On a public deployment that is an unauthenticated
 * subscriber to other people's session events.
 *
 * The Origin check exists for a different attack: browsers do not apply CORS
 * to WebSocket handshakes, so the REST allowlist does nothing here. Without
 * it, any page a logged-in user visits can open a socket to the Control Plane.
 */
describe('web client websocket authentication', () => {
  let cp: ControlPlane;
  let clientUrl: string;
  let token: string;

  beforeEach(async () => {
    cp = new ControlPlane({ port: 0, corsOrigins: ['https://app.odysseus.test'] });
    await cp.start();
    clientUrl = cp.getWsClientUrl();

    const res = await fetch(`${cp.getUrl()}/api/v1/auth/register`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: 'ws-auth@test.dev', password: 'Password123!' }),
    });
    token = ((await res.json()) as { accessToken: string }).accessToken;
  });

  afterEach(async () => {
    await cp.stop();
  });

  /** Resolve with how the socket ended up: open, or closed with a code. */
  function outcomeOf(ws: WebSocket): Promise<{ opened: boolean; code?: number }> {
    return new Promise((resolve) => {
      let opened = false;
      const timer = setTimeout(() => resolve({ opened }), 3_000);

      ws.on('message', (data) => {
        const msg = JSON.parse(data.toString('utf8')) as { type?: string };
        if (msg.type === 'connected') {
          opened = true;
          clearTimeout(timer);
          resolve({ opened: true });
        }
      });
      ws.on('close', (code: number) => {
        clearTimeout(timer);
        resolve({ opened, code });
      });
      ws.on('error', () => {
        /* a refused upgrade surfaces as an error then a close */
      });
    });
  }

  it('refuses a connection with no token', async () => {
    const ws = new WebSocket(clientUrl);
    const outcome = await outcomeOf(ws);

    expect(outcome.opened).toBe(false);
    expect(outcome.code).toBe(4001);
  });

  it('refuses a connection with an invalid token', async () => {
    const ws = new WebSocket(`${clientUrl}?token=not-a-real-token`);
    const outcome = await outcomeOf(ws);

    expect(outcome.opened).toBe(false);
    expect(outcome.code).toBe(4001);
  });

  it('accepts a connection with a valid token', async () => {
    const ws = new WebSocket(`${clientUrl}?token=${token}`);
    const outcome = await outcomeOf(ws);

    expect(outcome.opened).toBe(true);
    ws.close();
  });

  it('accepts a valid token in an Authorization header', async () => {
    // Browsers cannot set this, but non-browser clients should not be forced
    // to put a credential in a URL, where it lands in logs.
    const ws = new WebSocket(clientUrl, { headers: { Authorization: `Bearer ${token}` } });
    const outcome = await outcomeOf(ws);

    expect(outcome.opened).toBe(true);
    ws.close();
  });

  it('rejects a websocket upgrade from an origin that is not allowlisted', async () => {
    const ws = new WebSocket(`${clientUrl}?token=${token}`, {
      headers: { Origin: 'https://evil.example.com' },
    });
    const outcome = await outcomeOf(ws);

    expect(outcome.opened).toBe(false);
  });

  it('allows a websocket upgrade from an allowlisted origin', async () => {
    const ws = new WebSocket(`${clientUrl}?token=${token}`, {
      headers: { Origin: 'https://app.odysseus.test' },
    });
    const outcome = await outcomeOf(ws);

    expect(outcome.opened).toBe(true);
    ws.close();
  });

  it('treats a request with no Origin as a non-browser caller', () => {
    // curl, a native app and the test suite send no Origin. They are still
    // gated by the token; the Origin check is specifically about stopping a
    // browser from acting on another site's behalf.
    expect(cp.isAllowedWebSocketOrigin(undefined)).toBe(true);
    expect(cp.isAllowedWebSocketOrigin('https://evil.example.com')).toBe(false);
    expect(cp.isAllowedWebSocketOrigin('https://app.odysseus.test')).toBe(true);
  });
});
