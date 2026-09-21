import { createPublicKey, verify } from 'node:crypto';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { HistorySync, IntegrationManager } from '@odysseus/integrations';
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
 * Past conversations and usage, end to end: fixture Codex files on a throwaway
 * workstation, the real gateway-side HistorySync, the real Control Plane.
 */
const SESSION = '0194e3a2-7b1c-4f6e-9d2a-5c8b1e4f7a90';
const KEY = 'sk-proj-AbCdEf1234567890AbCdEf1234567890AbCdEf12';
const j = (value: unknown) => JSON.stringify(value);

describe('imported history and usage', () => {
  let cp: ControlPlane;
  let base: string;
  let home: string;
  let identity: TestDeviceIdentity;
  let manager: IntegrationManager;
  let history: HistorySync;
  let gw: WebSocket | undefined;
  let ownerToken: string;
  let otherToken: string;

  const send = (payload: unknown) =>
    gw?.readyState === 1 &&
    gw.send(JSON.stringify({ id: `u_${Math.random()}`, type: 'integration_update', sequence: 9, payload }));

  async function register(email: string) {
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
    return { status: res.status, body: (await res.json().catch(() => ({}))) as any };
  }

  async function connectGateway() {
    const socket = new WebSocket(cp.getWsTunnelUrl());
    await new Promise<void>((resolve) => socket.on('open', () => resolve()));
    socket.on('message', (data) => {
      const msg = JSON.parse(data.toString('utf8'));
      if (msg.type !== 'command') return;
      void (async () => {
        const { commandType, payload } = msg.payload;
        let reply: { success: boolean; result?: unknown; error?: string };
        try {
          if (commandType === 'integration.grant_request') reply = { success: true, result: await manager.receiveRequest(payload) };
          else if (commandType === 'integration.revoke') reply = { success: true, result: await manager.revoke(payload.integration, 'web') };
          else if (commandType === 'integration.sync') {
            void history.syncAll(payload.integration).catch(() => undefined);
            reply = { success: true, result: { started: true } };
          } else if (commandType === 'integration.sync_content') reply = { success: true, result: await history.syncContent(payload.integration, payload.externalId) };
          else reply = { success: false, error: 'unsupported' };
        } catch (error) {
          reply = { success: false, error: (error as Error).message };
        }
        socket.send(JSON.stringify({ id: `ack_${msg.id}`, type: 'ack', sequence: 5, correlationId: msg.id, payload: reply }));
      })();
    });
    const handshake = await performHandshake(socket, identity);
    if (!handshake.ok) throw new Error('handshake refused');
    return socket;
  }

  async function waitFor<T>(check: () => Promise<T | undefined>, timeoutMs = 6000): Promise<T> {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const value = await check();
      if (value !== undefined) return value;
      if (Date.now() > deadline) throw new Error('timed out');
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
  }

  async function connectCodex(scopes = ['history.read', 'usage.read']) {
    const created = await api('POST', `/api/v1/devices/${identity.deviceId}/integrations/codex/requests`, ownerToken, { scopes });
    expect(created.status).toBe(201);
    const [pending] = await manager.pendingRequests();
    expect((await manager.approve(pending!.requestId, created.body.confirmationCode, { interactive: true })).ok).toBe(true);
    await waitFor(async () =>
      (await cp.db.integrationGrants.find(identity.deviceId, 'codex'))?.status === 'active' ? true : undefined,
    );
  }

  const listHistory = async (token = ownerToken) => (await api('GET', '/api/v1/history', token)).body as any[];

  beforeEach(async () => {
    cp = new ControlPlane({ port: 0 });
    await cp.start();
    base = cp.getUrl();

    home = mkdtempSync(join(tmpdir(), 'odysseus-cp-history-'));
    const dir = join(home, '.codex', 'sessions', '2026', '09', '10');
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      join(dir, `rollout-2026-09-10T10-00-00-${SESSION}.jsonl`),
      [
        j({ timestamp: '2026-09-10T10:00:00Z', type: 'session_meta', payload: { id: SESSION, timestamp: '2026-09-10T10:00:00Z', cwd: join(home, 'project') } }),
        j({ timestamp: '2026-09-10T10:00:03Z', type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: `Fix login ${KEY}` }] } }),
        j({ timestamp: '2026-09-10T10:00:05Z', type: 'response_item', payload: { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'Done' }] } }),
        j({ timestamp: '2026-09-10T10:00:08Z', type: 'event_msg', payload: { type: 'token_count', info: { total_token_usage: { input_tokens: 900, output_tokens: 100, total_tokens: 1000 } }, rate_limits: { primary: { used_percent: 14, window_minutes: 300, resets_at: 1789990846 }, plan_type: 'plus' } } }),
        '',
      ].join('\n'),
    );

    ownerToken = await register('owner@history.test');
    otherToken = await register('other@history.test');
    const owner = (await cp.db.users.findByEmail('owner@history.test'))!;
    identity = createTestIdentity('dev_history', 'gw_history');
    await cp.db.devices.create(deviceRecordFor(identity, { userId: owner.id }) as never);

    const publicKey = createPublicKey({ key: identity.publicKeyJwk as never, format: 'jwk' });
    const ctx = { home, odysseusHome: join(home, '.odysseus') };
    manager = new IntegrationManager({
      signer: { deviceId: identity.deviceId, sign: identity.sign, verify: (d, s) => verify(null, Buffer.from(d), publicKey, Buffer.from(s, 'base64')) },
      ctx,
      onUpdate: (update) => {
        send(update);
        // As start-gateway does: a newly active grant syncs straight away.
        if (update.kind === 'grant_changed' && update.state.status === 'active') {
          void history.syncAll(update.state.integration).catch(() => undefined);
        }
      },
    });
    history = new HistorySync({ manager, ctx, emit: send });
    gw = await connectGateway();
  });

  afterEach(async () => {
    gw?.close();
    await cp.stop();
    rmSync(home, { recursive: true, force: true });
  });

  it('shows past conversations as soon as access is approved, titles only', async () => {
    await connectCodex();
    const conversations = await waitFor(async () => {
      const list = await listHistory();
      return list.length ? list : undefined;
    });
    expect(conversations[0]).toMatchObject({ integration: 'codex', externalId: SESSION, contentSynced: false, workspace: '~/project' });
    // The title is redacted on the workstation; the key never reached the cloud.
    expect(conversations[0].title).toContain('Fix login');
    expect(JSON.stringify(conversations)).not.toContain(KEY);

    const detail = await api('GET', `/api/v1/history/${conversations[0].id}`, ownerToken);
    expect(detail.body.items).toEqual([]);
  });

  it('syncs one conversation\'s content only when asked', async () => {
    await connectCodex();
    const [conversation] = await waitFor(async () => ((await listHistory()).length ? listHistory() : undefined));
    const asked = await api('POST', `/api/v1/history/${conversation.id}/content`, ownerToken);
    expect(asked.status).toBe(202);
    const detail = await waitFor(async () => {
      const res = await api('GET', `/api/v1/history/${conversation.id}`, ownerToken);
      return res.body.conversation?.contentSynced ? res.body : undefined;
    });
    expect(detail.items.map((item: any) => item.kind)).toEqual(['user', 'assistant']);
    expect(JSON.stringify(detail.items)).not.toContain(KEY);
  });

  it('shows plan limits and records tokens once, without inventing cost', async () => {
    await connectCodex();
    const usage = await waitFor(async () => {
      const res = await api('GET', '/api/v1/usage/providers', ownerToken);
      return res.body.length ? res.body : undefined;
    });
    expect(usage[0].snapshot).toMatchObject({ provider: 'codex', planType: 'plus' });
    expect(usage[0].snapshot.windows[0]).toMatchObject({ name: 'primary', usedPercent: 14, windowMinutes: 300 });

    // A second sync of the same unchanged session must not count its tokens again.
    await api('POST', `/api/v1/devices/${identity.deviceId}/integrations/codex/sync`, ownerToken);
    await new Promise((resolve) => setTimeout(resolve, 400));
    const [conversation] = await listHistory();
    const costs = await cp.db.orchestration.listCosts({ sessionId: conversation.id });
    expect(costs.reduce((sum, cost) => sum + cost.tokens, 0)).toBe(1000);
    expect(costs.every((cost) => cost.costUsd === 0 && cost.billing === 'subscription')).toBe(true);
  });

  it('keeps one user\'s history from another', async () => {
    await connectCodex();
    const [conversation] = await waitFor(async () => ((await listHistory()).length ? listHistory() : undefined));
    expect(await listHistory(otherToken)).toEqual([]);
    expect((await api('GET', `/api/v1/history/${conversation.id}`, otherToken)).status).toBe(404);
    expect((await api('POST', `/api/v1/history/${conversation.id}/content`, otherToken)).status).toBe(404);
    expect((await api('GET', '/api/v1/usage/providers', otherToken)).body).toEqual([]);
  });

  it('deletes synced history and usage on revoke, and drops anything that arrives afterwards', async () => {
    await connectCodex();
    await waitFor(async () => ((await listHistory()).length ? true : undefined));

    const revoked = await api('DELETE', `/api/v1/devices/${identity.deviceId}/integrations/codex`, ownerToken);
    expect(revoked.status).toBe(200);
    expect(await listHistory()).toEqual([]);
    expect((await api('GET', '/api/v1/usage/providers', ownerToken)).body).toEqual([]);

    // A scan that was already in flight when the revoke happened.
    send({
      kind: 'history_summaries',
      integration: 'codex',
      conversations: [{ externalId: SESSION, integration: 'codex', title: 'late', startedAt: '2026-09-10T10:00:00Z', updatedAt: '2026-09-10T10:00:00Z', messageCount: 1, toolCallCount: 0, hasTranscript: true }],
      complete: true,
      scanId: 'scan_late',
    });
    await new Promise((resolve) => setTimeout(resolve, 300));
    expect(await listHistory()).toEqual([]);
  });

  it('refuses a sync for an integration that is not connected', async () => {
    const res = await api('POST', `/api/v1/devices/${identity.deviceId}/integrations/codex/sync`, ownerToken);
    expect(res.status).toBe(409);
  });

  it('drops malformed or oversized data from the gateway instead of storing it', async () => {
    await connectCodex();
    const [conversation] = await waitFor(async () => ((await listHistory()).length ? listHistory() : undefined));
    send({
      kind: 'history_content',
      integration: 'codex',
      externalId: SESSION,
      part: 0,
      final: true,
      truncated: false,
      items: [
        { seq: 0, kind: 'user', text: 'ok' },
        { seq: 1, kind: 'rootkit', text: 'not a real kind' },
        { seq: 2, kind: 'assistant', text: 'x'.repeat(50_000) },
        { seq: 3, kind: 'user' },
      ],
    });
    const detail = await waitFor(async () => {
      const res = await api('GET', `/api/v1/history/${conversation.id}`, ownerToken);
      return res.body.conversation?.contentSynced ? res.body : undefined;
    });
    expect(detail.items.map((item: any) => item.kind)).toEqual(['user', 'assistant']);
    expect(detail.items[1].text.length).toBeLessThanOrEqual(4001);
  });
});
