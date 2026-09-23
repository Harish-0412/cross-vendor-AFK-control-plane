import { createPublicKey, verify } from 'node:crypto';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { IntegrationManager } from '@odysseus/integrations';
import { WebSocket } from 'ws';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { ControlPlane } from '../src/control-plane';

import {
  createTestIdentity,
  deviceRecordFor,
  performHandshake,
  type TestDeviceIdentity,
} from './helpers/gateway-handshake';

/**
 * Integration access end to end: the real Control Plane routes and tunnel, and
 * a gateway running the real IntegrationManager against a throwaway home
 * directory. The web app may request and revoke; only the workstation grants.
 */
describe('integration access', () => {
  let cp: ControlPlane;
  let base: string;
  let home: string;
  let identity: TestDeviceIdentity;
  let manager: IntegrationManager;
  let gw: WebSocket | undefined;
  let ownerToken: string;
  let otherToken: string;

  async function register(email: string): Promise<string> {
    const res = await fetch(`${base}/api/v1/auth/register`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email, password: 'Password123!' }),
    });
    return ((await res.json()) as { accessToken: string }).accessToken;
  }

  async function api(method: string, path: string, token: string, body?: unknown) {
    const res = await fetch(`${base}${path}`, {
      method,
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      ...(body ? { body: JSON.stringify(body) } : {}),
    });
    return { status: res.status, body: (await res.json().catch(() => ({}))) as Record<string, unknown> };
  }

  /** A gateway that answers commands with the real manager, like start-gateway does. */
  async function connectGateway(): Promise<WebSocket> {
    // The command listener is attached before the handshake, as the real gateway's
    // is: the Control Plane sends queued work (a held revoke) straight after
    // auth_success, and a listener added afterwards could miss it.
    const socket = new WebSocket(cp.getWsTunnelUrl());
    await new Promise<void>((resolve) => socket.on('open', () => resolve()));
    socket.on('message', (data) => {
      const msg = JSON.parse(data.toString('utf8')) as {
        id: string;
        type: string;
        payload: { commandType: string; payload: Record<string, unknown> };
      };
      if (msg.type !== 'command') return;
      void (async () => {
        const { commandType, payload } = msg.payload;
        let reply: { success: boolean; result?: unknown; error?: string };
        try {
          if (commandType === 'integration.grant_request') {
            reply = { success: true, result: await manager.receiveRequest(payload) };
          } else if (commandType === 'integration.revoke') {
            reply = { success: true, result: { revoked: await manager.revoke(payload['integration'], 'web') } };
          } else if (commandType === 'integration.list') {
            reply = { success: true, result: await manager.list() };
          } else {
            reply = { success: false, error: `Unsupported command: ${commandType}` };
          }
        } catch (error) {
          reply = { success: false, error: (error as Error).message };
        }
        socket.send(
          JSON.stringify({ id: `ack_${msg.id}`, type: 'ack', sequence: 5, correlationId: msg.id, payload: reply }),
        );
      })();
    });
    const handshake = await performHandshake(socket, identity);
    if (!handshake.ok) throw new Error('gateway handshake refused');
    return socket;
  }

  async function waitFor<T>(check: () => Promise<T | undefined>, timeoutMs = 5000): Promise<T> {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const value = await check();
      if (value !== undefined) return value;
      if (Date.now() > deadline) throw new Error('timed out');
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
  }

  async function mirrorStatus(): Promise<string | undefined> {
    const record = await cp.db.integrationGrants.find(identity.deviceId, 'codex');
    return record?.status;
  }

  beforeEach(async () => {
    cp = new ControlPlane({ port: 0 });
    await cp.start();
    base = cp.getUrl();

    home = mkdtempSync(join(tmpdir(), 'odysseus-cp-integrations-'));
    mkdirSync(join(home, '.codex', 'sessions', '2026', '09', '21'), { recursive: true });
    writeFileSync(join(home, '.codex', 'sessions', '2026', '09', '21', 'rollout-2026-09-21T10-00-00-aaaa.jsonl'), '{}\n');

    ownerToken = await register('owner@integrations.test');
    otherToken = await register('other@integrations.test');
    const owner = (await cp.db.users.findByEmail('owner@integrations.test'))!;

    identity = createTestIdentity('dev_integrations', 'gw_integrations');
    await cp.db.devices.create(deviceRecordFor(identity, { userId: owner.id }) as never);

    const publicKey = createPublicKey({ key: identity.publicKeyJwk as never, format: 'jwk' });
    manager = new IntegrationManager({
      signer: {
        deviceId: identity.deviceId,
        sign: identity.sign,
        verify: (data, signature) => verify(null, Buffer.from(data), publicKey, Buffer.from(signature, 'base64')),
      },
      ctx: { home, odysseusHome: join(home, '.odysseus') },
      onUpdate: (update) =>
        gw?.readyState === 1 &&
        gw.send(JSON.stringify({ id: `upd_${Date.now()}`, type: 'integration_update', sequence: 9, payload: update })),
    });
    gw = await connectGateway();
  });

  afterEach(async () => {
    gw?.close();
    await cp.stop();
    rmSync(home, { recursive: true, force: true });
  });

  const requestPath = () => `/api/v1/devices/${identity.deviceId}/integrations/codex/requests`;

  it('request → approve at the workstation → active, end to end', async () => {
    const created = await api('POST', requestPath(), ownerToken, { scopes: ['history.read', 'usage.read'] });
    expect(created.status).toBe(201);
    const code = created.body['confirmationCode'] as string;
    expect(code).toMatch(/^[A-Z0-9]{3}-[A-Z0-9]{3}$/);
    expect(await mirrorStatus()).toBe('pending');

    // Nothing is readable yet.
    expect((await manager.guard.authorize('codex', 'history.read')).allowed).toBe(false);

    const [pending] = await manager.pendingRequests();
    const approved = await manager.approve(pending!.requestId, code, { interactive: true });
    expect(approved.ok).toBe(true);

    expect(await waitFor(async () => ((await mirrorStatus()) === 'active' ? true : undefined))).toBe(true);
    const record = await cp.db.integrationGrants.find(identity.deviceId, 'codex');
    // The cloud copy shows folders as ~ paths, never the local account name.
    expect(record?.roots?.[0]).toBe('~/.codex/sessions');

    const audit = await cp.auditLog.list({ deviceId: identity.deviceId } as never);
    expect(JSON.stringify(audit)).toContain('integration.codex.active');
  });

  it('offers no way to approve from the web', async () => {
    const created = await api('POST', requestPath(), ownerToken, { scopes: ['history.read'] });
    expect(created.status).toBe(201);
    for (const [method, path] of [
      ['POST', `/api/v1/devices/${identity.deviceId}/integrations/codex/approve`],
      ['PUT', `/api/v1/devices/${identity.deviceId}/integrations/codex`],
      ['PATCH', `/api/v1/devices/${identity.deviceId}/integrations/codex`],
    ] as const) {
      const res = await api(method, path, ownerToken, { code: created.body['confirmationCode'], status: 'active' });
      expect([404, 405]).toContain(res.status);
    }
    expect((await manager.guard.authorize('codex', 'history.read')).allowed).toBe(false);
  });

  it("another user can neither see nor request access on someone else's device", async () => {
    const list = await api('GET', `/api/v1/devices/${identity.deviceId}/integrations`, otherToken);
    expect(list.status).toBe(404);
    const request = await api('POST', requestPath(), otherToken, { scopes: ['history.read'] });
    expect(request.status).toBe(404);
    expect(await manager.pendingRequests()).toHaveLength(0);
  });

  it('rejects unknown integrations and scopes an integration does not offer', async () => {
    const unknown = await api('POST', `/api/v1/devices/${identity.deviceId}/integrations/everything/requests`, ownerToken, { scopes: ['history.read'] });
    expect(unknown.status).toBe(404);
    const scope = await api('POST', requestPath(), ownerToken, { scopes: ['unsupported.scope'] });
    expect(scope.status).toBe(400);
  });

  it('a wrong code at the workstation leaves the integration inactive', async () => {
    await api('POST', requestPath(), ownerToken, { scopes: ['history.read'] });
    const [pending] = await manager.pendingRequests();
    const result = await manager.approve(pending!.requestId, 'ZZZ-ZZZ', { interactive: true });
    expect(result.ok).toBe(false);
    expect(await mirrorStatus()).toBe('pending');
  });

  it('revoking from the web removes the grant on the workstation', async () => {
    const created = await api('POST', requestPath(), ownerToken, { scopes: ['history.read'] });
    const [pending] = await manager.pendingRequests();
    await manager.approve(pending!.requestId, created.body['confirmationCode'] as string, { interactive: true });
    await waitFor(async () => ((await mirrorStatus()) === 'active' ? true : undefined));

    const revoked = await api('DELETE', `/api/v1/devices/${identity.deviceId}/integrations/codex`, ownerToken);
    expect(revoked.status).toBe(200);
    expect(revoked.body['delivered']).toBe(true);
    expect((await manager.guard.authorize('codex', 'history.read')).allowed).toBe(false);
    expect(await mirrorStatus()).toBe('revoked');
  });

  it('a revoke made while the workstation is offline is delivered when it reconnects', async () => {
    const created = await api('POST', requestPath(), ownerToken, { scopes: ['history.read'] });
    const [pending] = await manager.pendingRequests();
    await manager.approve(pending!.requestId, created.body['confirmationCode'] as string, { interactive: true });
    await waitFor(async () => ((await mirrorStatus()) === 'active' ? true : undefined));

    gw!.close();
    await waitFor(async () => (cp.registry.isDeviceOnline(identity.deviceId) ? undefined : true));

    const revoked = await api('DELETE', `/api/v1/devices/${identity.deviceId}/integrations/codex`, ownerToken);
    expect(revoked.body['delivered']).toBe(false);
    // Still granted on the workstation — it has not heard yet.
    expect((await manager.guard.authorize('codex', 'history.read')).allowed).toBe(true);

    gw = await connectGateway();
    expect(
      await waitFor(async () =>
        (await manager.guard.authorize('codex', 'history.read')).allowed ? undefined : true,
      ),
    ).toBe(true);
  });

  it('a request to an offline workstation fails clearly instead of hanging', async () => {
    gw!.close();
    await waitFor(async () => (cp.registry.isDeviceOnline(identity.deviceId) ? undefined : true));
    const res = await api('POST', requestPath(), ownerToken, { scopes: ['history.read'] });
    expect(res.status).toBe(409);
    expect(String(res.body['error'])).toMatch(/offline/);
  });
});
