import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';

import { WebSocket } from 'ws';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import type { IDatabase } from '../src/db/types';
import { ClientServer } from '../src/tunnel/client-server';
import { ConnectionRegistry } from '../src/tunnel/connection-registry';

/**
 * REST accepts Firebase ID tokens, but the browser socket used to accept only
 * Control Plane JWTs. A Google-signed-in user was therefore never "present",
 * and everything their workstation gates on presence — history, usage, remote
 * Codex and Antigravity sessions — stayed paused.
 */
describe('web client socket with a Firebase ID token', () => {
  let server: Server;
  let url: string;
  let registry: ConnectionRegistry;
  let clients: ClientServer;
  const presence: Array<[string, number]> = [];

  beforeEach(async () => {
    registry = new ConnectionRegistry();
    clients = new ClientServer(registry, 'test-secret', {} as IDatabase, async (token) =>
      token === 'firebase-id-token' ? 'firebase-uid-1' : null,
    );
    clients.setOnPresenceChange((userId, count) => {
      presence.push([userId, count]);
    });
    server = createServer();
    server.on('upgrade', (req, socket, head) => clients.handleUpgrade(req, socket, head));
    await new Promise<void>((resolve) => server.listen(0, resolve));
    url = `ws://127.0.0.1:${(server.address() as AddressInfo).port}/ws/client`;
    presence.length = 0;
  });

  afterEach(async () => {
    clients.close();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  function connect(token: string): Promise<{ opened: boolean; code?: number; userId?: string }> {
    return new Promise((resolve) => {
      const ws = new WebSocket(url);
      ws.on('open', () => ws.send(JSON.stringify({ type: 'auth', token })));
      ws.on('message', (data) => {
        const msg = JSON.parse(data.toString('utf8')) as { type?: string; userId?: string };
        if (msg.type === 'connected') {
          resolve({ opened: true, ...(msg.userId ? { userId: msg.userId } : {}) });
          ws.close();
        }
      });
      ws.on('close', (code: number) => resolve({ opened: false, code }));
      ws.on('error', () => undefined);
    });
  }

  it('accepts a Firebase ID token and registers the user as present', async () => {
    const outcome = await connect('firebase-id-token');

    expect(outcome).toEqual({ opened: true, userId: 'firebase-uid-1' });
    expect(presence).toContainEqual(['firebase-uid-1', 1]);
  });

  it('still refuses a token neither verifier accepts', async () => {
    const outcome = await connect('forged');

    expect(outcome.opened).toBe(false);
    expect(outcome.code).toBe(4001);
  });
});
