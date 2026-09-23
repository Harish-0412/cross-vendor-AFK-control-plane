import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import type { IntegrationUpdate } from '@odysseus/protocol';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { grantSigningPayload, type StoredGrant } from '../src/grant-store';
import { IntegrationManager } from '../src/integration-manager';
import { grantsFile } from '../src/paths';

import { CODE, createHome, createSigner, makeRequest, writeFile } from './helpers';

/**
 * Written from the attacker's side. Each test is a way someone might try to
 * get an integration's data without the workstation owner approving it, and
 * each must fail.
 */
describe('integration consent', () => {
  let home: ReturnType<typeof createHome>;
  let manager: IntegrationManager;
  let updates: IntegrationUpdate[];
  const signer = createSigner('dev_this_machine');

  beforeEach(() => {
    home = createHome();
    // Give Codex a sessions folder so a grant has something to cover.
    writeFile(
      join(
        home.home,
        '.codex',
        'sessions',
        '2026',
        '09',
        '21',
        'rollout-2026-09-21T10-00-00-aaaa.jsonl',
      ),
      '{}\n',
    );
    updates = [];
    manager = new IntegrationManager({
      signer,
      ctx: home,
      onUpdate: (update) => updates.push(update),
    });
  });

  afterEach(() => home.cleanup());

  async function requestAndApprove() {
    const request = makeRequest();
    await manager.receiveRequest(request);
    const result = await manager.approve(request.requestId, CODE, { interactive: true });
    expect(result.ok).toBe(true);
    return request;
  }

  // ------------------------------------------------------------- requesting

  it('a request alone grants nothing', async () => {
    await manager.receiveRequest(makeRequest());
    const access = await manager.guard.authorize('codex', 'history.read');
    expect(access.allowed).toBe(false);
    expect(updates.some((u) => u.kind === 'grant_changed' && u.state.status === 'pending')).toBe(
      true,
    );
  });

  it('refuses a request for a scope the integration does not offer', async () => {
    await expect(
      manager.receiveRequest(makeRequest('antigravity', ['usage.read'])),
    ).rejects.toThrow(/not offered/);
  });

  it('refuses an unknown integration', async () => {
    await expect(
      manager.receiveRequest({ ...makeRequest(), integration: 'everything' }),
    ).rejects.toThrow(/Unknown integration/);
  });

  it('refuses a request that asks to stay open far longer than the window', async () => {
    const tooLong = makeRequest('codex', ['history.read'], {
      expiresAt: new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString(),
    });
    await expect(manager.receiveRequest(tooLong)).rejects.toThrow(/expiry/);
  });

  it('refuses a request with no confirmation code hash', async () => {
    const { confirmation: _drop, ...noCode } = makeRequest();
    await expect(manager.receiveRequest(noCode)).rejects.toThrow(/confirmation/);
  });

  it('refuses a replayed request id', async () => {
    const request = makeRequest();
    await manager.receiveRequest(request);
    await expect(manager.receiveRequest(request)).rejects.toThrow(/already received/);
  });

  // -------------------------------------------------------------- approving

  it('cannot be approved non-interactively', async () => {
    const request = makeRequest();
    await manager.receiveRequest(request);
    const result = await manager.approve(request.requestId, CODE, { interactive: false });
    expect(result.ok).toBe(false);
    expect((await manager.guard.authorize('codex', 'history.read')).allowed).toBe(false);
  });

  it('cannot be approved without the code shown in the browser', async () => {
    const request = makeRequest();
    await manager.receiveRequest(request);
    const result = await manager.approve(request.requestId, 'WRONG1', { interactive: true });
    expect(result.ok).toBe(false);
    expect((await manager.guard.authorize('codex', 'history.read')).allowed).toBe(false);
  });

  it('denies the request after five wrong codes, even if the right one follows', async () => {
    const request = makeRequest();
    await manager.receiveRequest(request);
    for (let i = 0; i < 5; i += 1) {
      await manager.approve(request.requestId, `BAD00${i}`, { interactive: true });
    }
    const late = await manager.approve(request.requestId, CODE, { interactive: true });
    expect(late.ok).toBe(false);
    expect((await manager.store.findRequest(request.requestId))?.status).toBe('denied');
  });

  it('cannot approve a request after it expires', async () => {
    let clock = Date.now();
    const timed = new IntegrationManager({ signer, ctx: home, now: () => clock });
    const request = makeRequest('codex', ['history.read'], {}, clock);
    await timed.receiveRequest(request);
    clock += 11 * 60 * 1000;
    const result = await timed.approve(request.requestId, CODE, { interactive: true });
    expect(result.ok).toBe(false);
  });

  it('accepts the right code at an interactive terminal, with only the requested scopes', async () => {
    const request = makeRequest('codex', ['history.read']);
    await manager.receiveRequest(request);
    const result = await manager.approve(request.requestId, 'k7q-2mx', { interactive: true });
    expect(result.ok).toBe(true);
    expect((await manager.guard.authorize('codex', 'history.read')).allowed).toBe(true);
    // Least privilege: history was granted, usage was not.
    expect((await manager.guard.authorize('codex', 'usage.read')).allowed).toBe(false);
  });

  // ------------------------------------------------------- forging a grant

  function readGrants(): { version: 1; grants: StoredGrant[] } {
    return JSON.parse(readFileSync(grantsFile(home), 'utf8'));
  }

  it('ignores a grant written by hand without a valid signature', async () => {
    const forged: StoredGrant = {
      grantId: 'grant_forged',
      requestId: 'req_forged',
      deviceId: signer.deviceId,
      userId: 'usr_attacker',
      integration: 'codex',
      scopes: ['history.read', 'usage.read'],
      roots: [join(home.home, '.codex', 'sessions')],
      grantedAt: new Date().toISOString(),
      expiresAt: new Date(Date.now() + 86_400_000).toISOString(),
      approvedOn: 'workstation',
      signature: 'bm90IGEgcmVhbCBzaWduYXR1cmU=',
    };
    writeFile(grantsFile(home), JSON.stringify({ version: 1, grants: [forged] }));
    expect((await manager.guard.authorize('codex', 'history.read')).allowed).toBe(false);
  });

  it('ignores a real grant whose scopes were edited afterwards', async () => {
    await requestAndApprove();
    const file = readGrants();
    file.grants[0]!.scopes = ['history.read', 'usage.read', 'session.run'];
    writeFileSync(grantsFile(home), JSON.stringify(file));
    expect((await manager.guard.authorize('codex', 'history.read')).allowed).toBe(false);
  });

  it('ignores a real grant whose folders were widened afterwards', async () => {
    await requestAndApprove();
    const file = readGrants();
    file.grants[0]!.roots = [home.home];
    writeFileSync(grantsFile(home), JSON.stringify(file));
    expect((await manager.guard.authorize('codex', 'history.read')).allowed).toBe(false);
  });

  it('ignores a grant copied from another device', async () => {
    const other = createSigner('dev_other_machine');
    const unsigned = {
      grantId: 'grant_other',
      requestId: 'req_other',
      deviceId: other.deviceId,
      userId: 'usr_owner',
      integration: 'codex' as const,
      scopes: ['history.read' as const],
      roots: [join(home.home, '.codex', 'sessions')],
      grantedAt: new Date().toISOString(),
      expiresAt: new Date(Date.now() + 86_400_000).toISOString(),
      approvedOn: 'workstation' as const,
    };
    const signed = { ...unsigned, signature: other.sign(grantSigningPayload(unsigned)) };
    writeFile(grantsFile(home), JSON.stringify({ version: 1, grants: [signed] }));
    expect((await manager.guard.authorize('codex', 'history.read')).allowed).toBe(false);
  });

  it('ignores a grant signed by another key that claims this device id', async () => {
    const impostor = createSigner(signer.deviceId);
    const unsigned = {
      grantId: 'grant_impostor',
      requestId: 'req_impostor',
      deviceId: signer.deviceId,
      userId: 'usr_owner',
      integration: 'codex' as const,
      scopes: ['history.read' as const],
      roots: [join(home.home, '.codex', 'sessions')],
      grantedAt: new Date().toISOString(),
      expiresAt: new Date(Date.now() + 86_400_000).toISOString(),
      approvedOn: 'workstation' as const,
    };
    const signed = { ...unsigned, signature: impostor.sign(grantSigningPayload(unsigned)) };
    writeFile(grantsFile(home), JSON.stringify({ version: 1, grants: [signed] }));
    expect((await manager.guard.authorize('codex', 'history.read')).allowed).toBe(false);
  });

  it('treats a corrupt grants file as no grants, failing closed', async () => {
    await requestAndApprove();
    writeFileSync(grantsFile(home), '{ this is not json');
    expect((await manager.guard.authorize('codex', 'history.read')).allowed).toBe(false);
  });

  it('stops honouring a grant once it expires', async () => {
    let clock = Date.now();
    const timed = new IntegrationManager({ signer, ctx: home, now: () => clock });
    const request = makeRequest('codex', ['history.read'], {}, clock);
    await timed.receiveRequest(request);
    await timed.approve(request.requestId, CODE, { interactive: true });
    expect((await timed.guard.authorize('codex', 'history.read')).allowed).toBe(true);
    clock += 91 * 24 * 60 * 60 * 1000;
    expect((await timed.guard.authorize('codex', 'history.read')).allowed).toBe(false);
  });

  // ---------------------------------------------------------------- revoke

  it('refuses everything after a revoke', async () => {
    await requestAndApprove();
    await manager.revoke('codex', 'web');
    expect((await manager.guard.authorize('codex', 'history.read')).allowed).toBe(false);
    expect(updates.some((u) => u.kind === 'grant_changed' && u.state.status === 'revoked')).toBe(
      true,
    );
  });

  it('a revoke also cancels a request that was waiting, so it cannot be approved later', async () => {
    const request = makeRequest();
    await manager.receiveRequest(request);
    await manager.revoke('codex', 'web');
    const result = await manager.approve(request.requestId, CODE, { interactive: true });
    expect(result.ok).toBe(false);
  });

  it('reports refusals so the attempt reaches the audit log', async () => {
    await manager.guard.authorize('antigravity', 'history.read');
    expect(
      updates.some((u) => u.kind === 'access_refused' && u.integration === 'antigravity'),
    ).toBe(true);
  });

  it('delivers a new local website-termination request to the running gateway once', async () => {
    const disconnects: Array<{ id: string; requestedAt: string }> = [];
    const running = new IntegrationManager({
      signer,
      ctx: home,
      onLocalWebDisconnect: (request) => disconnects.push(request),
    });
    running.startWatching(10);

    try {
      // Let the watcher establish its baseline before the CLI-side manager
      // writes a new request into the local control file.
      await new Promise((resolve) => setTimeout(resolve, 25));
      const requestId = await manager.requestLocalWebDisconnect();
      await vi.waitFor(() => expect(disconnects).toHaveLength(1));
      expect(disconnects[0]?.id).toBe(requestId);

      // Further watch cycles must not replay the same request.
      await new Promise((resolve) => setTimeout(resolve, 30));
      expect(disconnects).toHaveLength(1);
    } finally {
      running.stopWatching();
    }
  });
});
