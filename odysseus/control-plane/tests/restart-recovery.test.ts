import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { ControlPlane } from '../src/control-plane';
import type { SessionRecord } from '../src/types';

/**
 * Sessions that survive a reboot: when a gateway reconnects, whatever it lost
 * is marked interrupted and the work continues — through policy — resuming
 * the agent's own conversation where it can.
 */
describe('restart recovery', () => {
  let cp: ControlPlane;
  let reply: unknown;
  const commands: Array<{ type: string; payload: Record<string, unknown> }> = [];
  const hourAgo = () => new Date(Date.now() - 60 * 60_000);

  beforeEach(async () => {
    commands.splice(0);
    reply = { interrupted: [], active: [] };
    cp = new ControlPlane({ port: 0, jwtSecret: 'restart-secret' });
    await cp.start();
    for (const id of ['usr_r', 'usr_other'])
      await cp.db.users.create({ id, email: `${id}@example.test`, name: id, role: 'owner' });
    await cp.db.devices.create({
      id: 'dev_r',
      userId: 'usr_r',
      gatewayId: 'gw_r',
      friendlyName: 'Workstation',
      platform: 'linux',
      publicKeyPem: '',
      publicKeyJwk: {},
      fingerprintHex: '',
      fingerprintWords: [],
      status: 'trusted',
      defaultTrustProfile: 'default',
    });
    cp.tunnelServer.sendCommandToDevice = async (_device, type, payload) => {
      commands.push({ type, payload: payload as Record<string, unknown> });
      if (type === 'session.interrupted')
        return {
          acknowledged: true,
          delivered: true,
          sequence: 1,
          payload: { success: true, result: reply },
        };
      return { acknowledged: true, delivered: true, sequence: 1, payload: { success: true } };
    };
  });

  afterEach(async () => cp.stop());

  const session = (id: string, overrides: Partial<SessionRecord> = {}) =>
    cp.db.sessions.create({
      id,
      userId: 'usr_r',
      deviceId: 'dev_r',
      gatewayId: 'gw_r',
      agentId: 'claude-code',
      projectRoot: '/work/app',
      state: 'running',
      trustProfile: 'default',
      config: { adapter: 'claude-code', projectRoot: '/work/app', prompt: 'Add CSV export' },
      startedAt: hourAgo(),
      ...overrides,
    });

  it('continues an interrupted session in the same agent conversation', async () => {
    await session('sess_cut');
    const pending = await cp.db.approvals.create({
      sessionId: 'sess_cut',
      deviceId: 'dev_r',
      userId: 'usr_r',
      actionType: 'process.exec',
      description: 'git push',
      status: 'pending',
    });
    reply = {
      interrupted: [
        {
          sessionId: 'sess_cut',
          adapter: 'claude-code',
          projectRoot: '/work/app',
          prompt: 'Add CSV export',
          nativeSessionId: 'claude-abc12345',
          startedAt: hourAgo().toISOString(),
        },
      ],
      active: [],
    };

    const result = await cp.restartRecovery.onGatewayConnected('dev_r');
    expect(result.continued).toEqual([
      expect.objectContaining({ from: 'sess_cut', state: 'running', resumedConversation: true }),
    ]);
    const continuedIn = result.continued[0]!.to;

    const old = await cp.db.sessions.findById('sess_cut');
    expect(old).toMatchObject({ state: 'crashed' });
    expect(old?.error).toContain(`continued in ${continuedIn}`);
    expect(old?.config.metadata?.['continuedIn']).toBe(continuedIn);
    expect((await cp.db.approvals.findById(pending.id))?.status).toBe('superseded');

    const start = commands.find((command) => command.type === 'session.start')!;
    const config = start.payload['config'] as {
      adapter: string;
      prompt: string;
      metadata: Record<string, unknown>;
    };
    expect(config.adapter).toBe('claude-code');
    expect(config.metadata).toMatchObject({
      resumedFrom: 'sess_cut',
      resumeNativeSessionId: 'claude-abc12345',
      interruption: 'restart',
    });
    expect(config.prompt).toMatch(/workstation restarted/);
  });

  it('briefs a fresh session when the agent cannot resume its conversation', async () => {
    await session('sess_open', {
      agentId: 'opencode',
      config: { adapter: 'opencode', projectRoot: '/work/app', prompt: 'Fix the flaky test' },
    });
    reply = {
      interrupted: [
        {
          sessionId: 'sess_open',
          adapter: 'opencode',
          projectRoot: '/work/app',
          startedAt: hourAgo().toISOString(),
        },
      ],
      active: [],
    };
    const result = await cp.restartRecovery.onGatewayConnected('dev_r');
    expect(result.continued[0]).toMatchObject({ resumedConversation: false });
    const config = commands.find((command) => command.type === 'session.start')!.payload[
      'config'
    ] as { prompt: string; metadata: Record<string, unknown> };
    expect(config.prompt).toContain('Fix the flaky test');
    expect(config.metadata['resumeNativeSessionId']).toBeUndefined();
  });

  it('retires sessions the gateway has no trace of, and leaves the rest alone', async () => {
    await session('sess_lost');
    await session('sess_live');
    await session('sess_new', { startedAt: new Date() });
    await session('sess_done', { state: 'completed' });
    await session('sess_held', { state: 'waiting_for_approval' });
    await cp.db.approvals.create({
      sessionId: 'sess_held',
      deviceId: 'dev_r',
      userId: 'usr_r',
      actionType: 'process.exec',
      description: 'Orchestration step',
      details: { pendingCommand: { commandType: 'session.start', payload: {} } },
      status: 'pending',
    });
    reply = { interrupted: [], active: ['sess_live'] };

    const result = await cp.restartRecovery.onGatewayConnected('dev_r');
    expect(result.lost).toEqual(['sess_lost']);
    expect((await cp.db.sessions.findById('sess_lost'))?.state).toBe('crashed');
    for (const [id, state] of [
      ['sess_live', 'running'],
      ['sess_new', 'running'],
      ['sess_done', 'completed'],
      ['sess_held', 'waiting_for_approval'],
    ])
      expect((await cp.db.sessions.findById(id))?.state).toBe(state);
    expect(commands.some((command) => command.type === 'session.start')).toBe(false);
  });

  it("ignores a journal entry for another user's session", async () => {
    await session('sess_theirs', { userId: 'usr_other' });
    reply = {
      interrupted: [
        {
          sessionId: 'sess_theirs',
          adapter: 'claude-code',
          projectRoot: '/x',
          startedAt: hourAgo().toISOString(),
        },
      ],
      active: [],
    };
    const result = await cp.restartRecovery.onGatewayConnected('dev_r');
    expect(result.continued).toEqual([]);
    expect((await cp.db.sessions.findById('sess_theirs'))?.state).toBe('running');
  });

  it('changes nothing when the gateway is too old to answer', async () => {
    await session('sess_lost');
    cp.tunnelServer.sendCommandToDevice = async () => ({
      acknowledged: true,
      delivered: true,
      sequence: 1,
      payload: { success: false, error: 'Unsupported command: session.interrupted' },
    });
    expect(await cp.restartRecovery.onGatewayConnected('dev_r')).toEqual({
      continued: [],
      lost: [],
    });
    expect((await cp.db.sessions.findById('sess_lost'))?.state).toBe('running');
  });
});
