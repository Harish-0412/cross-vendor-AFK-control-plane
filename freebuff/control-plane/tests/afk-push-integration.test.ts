import * as http from 'node:http';
import type { AddressInfo } from 'node:net';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { WebSocket } from 'ws';

import { AfkOrchestrator } from '../src/afk/afk-orchestrator';
import { PushSender, type WebPushTransport } from '../src/afk/push-sender';
import { MemoryDatabase } from '../src/db/memory-store';
import { ConnectionRegistry } from '../src/tunnel/connection-registry';

describe('Subphase 7.3 AFK push delivery', () => {
  let server: http.Server;
  let endpoint: string;
  const captured: string[] = [];

  beforeEach(async () => {
    captured.length = 0;
    server = http.createServer((request, response) => {
      let body = '';
      request.on('data', (chunk: Buffer) => { body += chunk.toString('utf8'); });
      request.on('end', () => {
        captured.push(body);
        response.writeHead(201);
        response.end();
      });
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const address = server.address() as AddressInfo;
    endpoint = `http://127.0.0.1:${address.port}/mock-push`;
  });

  afterEach(async () => new Promise<void>((resolve, reject) => {
    server.close((error) => error ? reject(error) : resolve());
  }));

  it('sends one specific approval push for trusted-afk and suppresses supervised foreground duplicates', async () => {
    const db = new MemoryDatabase();
    const registry = new ConnectionRegistry();
    const user = await db.users.create({
      email: 'push@freebuff.dev',
      passwordHash: '',
      name: 'Push User',
      role: 'user',
    });
    await db.devices.create({
      id: 'dev_push', userId: user.id, gatewayId: 'gw_push', friendlyName: 'Push Device',
      platform: 'linux', publicKeyPem: '', publicKeyJwk: {}, fingerprintHex: 'PUSH',
      fingerprintWords: ['push'], status: 'trusted',
    });
    await db.sessions.create({
      id: 'sess_push', userId: user.id, deviceId: 'dev_push', gatewayId: 'gw_push',
      agentId: 'mock', projectRoot: '/workspace', state: 'waiting_for_approval',
      trustProfile: 'trusted-afk',
      config: { projectRoot: '/workspace', adapter: 'mock' }, startedAt: new Date(),
    });
    await db.pushSubscriptions.upsert({
      userId: user.id,
      channel: 'web-push',
      endpoint,
      keys: { p256dh: 'mock-p256dh', auth: 'mock-auth' },
    });

    const transport: WebPushTransport = {
      setVapidDetails: () => undefined,
      sendNotification: async (subscription, payload) => {
        await fetch(subscription.endpoint, { method: 'POST', body: payload });
      },
    };
    const sender = new PushSender(db, { webPushTransport: transport, messaging: null });
    const orchestrator = new AfkOrchestrator(db, registry, sender);
    const envelope = {
      eventId: 'evt_approval',
      eventType: 'session.approval_required' as const,
      eventVersion: 1,
      sessionId: 'sess_push',
      deviceId: 'dev_push',
      sequence: 1,
      occurredAt: new Date('2026-09-08T12:00:00Z'),
      payload: { description: 'git push', resource: 'production' },
    };

    await orchestrator.handleEvent({
      id: 'stored_1', sessionId: 'sess_push', deviceId: 'dev_push', sequence: 1,
      eventType: envelope.eventType, envelope, storedAt: new Date(),
    });
    expect(captured).toHaveLength(1);
    const notification = JSON.parse(captured[0]!) as { title: string; body: string };
    expect(notification.title).toBe('Approval needed: git push to production');
    expect(notification.body).toBe('git push to production');

    await db.sessions.update('sess_push', { trustProfile: 'supervised' });
    registry.registerClient({
      clientId: 'client_foreground', userId: user.id,
      socket: { readyState: 1 } as WebSocket,
      connectedAt: new Date(), subscribedSessions: new Set(['sess_push']),
      subscribedDevices: new Set(),
    });
    await orchestrator.handleEvent({
      id: 'stored_2', sessionId: 'sess_push', deviceId: 'dev_push', sequence: 2,
      eventType: envelope.eventType, envelope: { ...envelope, sequence: 2 }, storedAt: new Date(),
    });
    expect(captured).toHaveLength(1);
  });
});
