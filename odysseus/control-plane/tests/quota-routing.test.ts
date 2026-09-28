import { describe, expect, it } from 'vitest';
import type { AgentInfo, OrchestrationRun, OrchestrationStep } from '@odysseus/protocol';

import { MemoryDatabase } from '../src/db/memory-store';
import { AgentRouter } from '../src/orchestration/agent-router';
import { CostGovernor } from '../src/orchestration/cost-governor';
import { TrackRecords } from '../src/orchestration/track-record';
import type { ConnectionRegistry } from '../src/tunnel/connection-registry';
import type { TunnelServer } from '../src/tunnel/tunnel-server';

const NOW = new Date('2026-09-27T12:00:00Z');
const minutes = (count: number) => new Date(NOW.getTime() + count * 60_000).toISOString();

const agent = (id: string): AgentInfo => ({
  metadata: {
    id,
    name: id,
    version: '1',
    platform: ['linux'],
    capabilities: {
      sessionCreation: 'supported',
      promptDelivery: 'supported',
      streaming: 'supported',
      cancellation: 'supported',
      diffCollection: 'supported',
      approvalInterception: 'unsupported',
      checkpointRecovery: 'supported',
      multiTurn: 'supported',
      fileOperations: 'supported',
      toolExecution: 'supported',
    },
  },
  installed: true,
  health: { status: 'healthy', lastCheckAt: NOW },
  lastDetectedAt: NOW,
});

async function fixture() {
  const db = new MemoryDatabase();
  await db.users.create({ id: 'u1', email: 'u1@example.test', name: 'u1', role: 'owner' });
  await db.devices.create({
    id: 'd1',
    userId: 'u1',
    gatewayId: 'g1',
    friendlyName: 'Workstation',
    platform: 'linux',
    publicKeyPem: '',
    publicKeyJwk: {},
    fingerprintHex: '',
    fingerprintWords: [],
    status: 'trusted',
    defaultTrustProfile: 'default',
  });
  await db.devices.update('d1', {
    availableAgents: ['claude-code', 'codex', 'opencode'].map((id) => ({
      id,
      capabilities: agent(id).metadata.capabilities,
    })),
  });
  await db.projects.create({
    id: 'p1',
    userId: 'u1',
    name: 'p1',
    root: '/p1',
    preferences: { protectedBranches: ['main'] },
  });
  return db;
}

function router(db: MemoryDatabase, agents: string[]) {
  const registry = {
    isDeviceOnline: () => true,
    isDeviceAcceptingSessions: () => true,
    getAdmissionPhase: () => 'running' as const,
  } as unknown as ConnectionRegistry;
  const tunnel = {
    sendCommandToDevice: async () => ({
      delivered: true,
      acknowledged: true,
      payload: { result: { agents: agents.map(agent), activeSessions: 0 } },
    }),
  } as unknown as TunnelServer;
  const costs = new CostGovernor(db);
  const records = new TrackRecords(db, () => NOW.getTime());
  return new AgentRouter(db, registry, tunnel, {
    quota: (userId, deviceId, agentId) => costs.quota(userId, deviceId, agentId, NOW),
    trackRecords: (userId, projectId) => records.forProject(userId, projectId),
  });
}

async function codexWindow(db: MemoryDatabase, usedPercent: number, resetsAt = minutes(90)) {
  await db.providerUsage.upsert({
    deviceId: 'd1',
    userId: 'u1',
    integration: 'codex',
    receivedAt: NOW,
    snapshot: {
      provider: 'codex',
      source: 'codex-rate-limits',
      observedAt: NOW.toISOString(),
      windows: [
        { name: 'primary', usedPercent, windowMinutes: 300, resetsAt },
        { name: 'secondary', usedPercent: 10, windowMinutes: 10_080, resetsAt: minutes(5_000) },
      ],
    },
  });
}

describe('cost governor: plan windows', () => {
  it('reads the provider window closest to running out', async () => {
    const db = await fixture();
    await codexWindow(db, 85);
    const quota = await new CostGovernor(db).quota('u1', 'd1', 'codex', NOW);
    expect(quota).toMatchObject({
      state: 'low',
      source: 'provider',
      window: { label: '5-hour limit', usedPercent: 85 },
    });
    expect(quota.detail).toBe('5-hour limit 85% used; resets in 1 h 30 min');
  });

  it('counts a window whose reset has passed as fresh', async () => {
    const db = await fixture();
    await codexWindow(db, 100, minutes(-5));
    expect((await new CostGovernor(db).quota('u1', 'd1', 'codex', NOW)).state).toBe('available');
  });

  it('treats a recorded limit hit as exhausted until it resets', async () => {
    const db = await fixture();
    await db.documents.put('vendor_limits', 'lim_1', 'u1', {
      agentId: 'claude-code',
      deviceId: 'd1',
      detectedAt: NOW.toISOString(),
      resetsAt: minutes(130),
      resetKnown: true,
      message: 'Claude AI usage limit reached',
      sessionId: 's1',
    });
    const governor = new CostGovernor(db);
    expect(await governor.quota('u1', 'd1', 'claude-code', NOW)).toMatchObject({
      state: 'exhausted',
      source: 'limit-hit',
      detail: 'Plan limit reached; resets in 2 h 10 min',
    });
    const later = new Date(NOW.getTime() + 131 * 60_000);
    expect((await governor.quota('u1', 'd1', 'claude-code', later)).state).toBe('unknown');
  });

  it('never guesses: no report means unknown', async () => {
    const db = await fixture();
    expect(await new CostGovernor(db).quota('u1', 'd1', 'opencode', NOW)).toMatchObject({
      state: 'unknown',
      source: 'none',
    });
  });

  it('lists every agent on every machine, most constrained first', async () => {
    const db = await fixture();
    await codexWindow(db, 100);
    const overview = await new CostGovernor(db).quotaOverview('u1', NOW);
    expect(overview.map((item) => [item.agentId, item.state])).toEqual([
      ['codex', 'exhausted'],
      ['claude-code', 'unknown'],
      ['opencode', 'unknown'],
    ]);
  });
});

describe('router: quota and track record', () => {
  it('skips an agent out of plan quota and says why', async () => {
    const db = await fixture();
    await codexWindow(db, 100);
    const decision = await router(db, ['codex', 'opencode']).route('u1', {
      projectId: 'p1',
      taskKind: 'implementation',
    });
    expect(decision.selected?.agentId).toBe('opencode');
    expect(decision.skipped).toEqual([
      {
        agentId: 'codex',
        deviceId: 'd1',
        reason: 'codex: 5-hour limit reached; resets in 1 h 30 min',
      },
    ]);
  });

  it('refuses rather than routing to an exhausted agent the caller required', async () => {
    const db = await fixture();
    await codexWindow(db, 100);
    const decision = await router(db, ['codex', 'opencode']).route('u1', {
      projectId: 'p1',
      taskKind: 'implementation',
      requiredAgentId: 'codex',
    });
    expect(decision.selected).toBeNull();
    expect(decision.reasons[0]).toBe('Every eligible agent is out of plan quota');
  });

  it('puts an agent running low after the others', async () => {
    const db = await fixture();
    await codexWindow(db, 90);
    const decision = await router(db, ['codex', 'opencode']).route('u1', {
      projectId: 'p1',
      taskKind: 'test',
      strategy: 'least_loaded',
    });
    expect(decision.selected?.agentId).toBe('opencode');
    expect(decision.alternatives.map((item) => item.agentId)).toEqual(['codex']);
  });

  it('prefers the agent whose work has held up on this project', async () => {
    const db = await fixture();
    // claude-code's builds pass their tests; codex's keep failing them.
    await db.organizations.create({ id: 'org1', name: 'org', ownerId: 'u1' });
    const step = (id: string, extra: Partial<OrchestrationStep>): OrchestrationStep => ({
      id,
      title: id,
      taskKind: 'implementation',
      prompt: id,
      dependsOn: [],
      state: 'completed',
      ...extra,
    });
    const run = (id: string, builder: string, passed: boolean): OrchestrationRun => ({
      id,
      organizationId: 'org1',
      userId: 'u1',
      state: 'completed',
      createdAt: NOW,
      updatedAt: NOW,
      plan: {
        id: `plan_${id}`,
        projectId: 'p1',
        title: id,
        createdAt: NOW,
        steps: [
          step('build', { agentId: builder }),
          step('test', {
            taskKind: 'test',
            agentId: 'opencode',
            dependsOn: ['build'],
            outcome: { summary: '', filesChanged: [], testsPassed: passed },
          }),
        ],
      },
    });
    for (let index = 0; index < 4; index++) {
      await db.orchestration.createRun(run(`good_${index}`, 'claude-code', true));
      await db.orchestration.createRun(run(`bad_${index}`, 'codex', false));
    }

    const decision = await router(db, ['codex', 'claude-code']).route('u1', {
      projectId: 'p1',
      taskKind: 'implementation',
    });
    expect(decision.selected?.agentId).toBe('claude-code');
    expect(decision.selected?.trackRecord).toMatchObject({ successes: 4, failures: 0, samples: 4 });
    expect(decision.reasons).toContain('Track record here: 4 of 4 went well (tests 4/4)');
    expect(decision.alternatives[0]?.trackRecord).toMatchObject({ successes: 0, failures: 4 });
  });

  it('does not let a couple of results reorder agents', async () => {
    const db = await fixture();
    await db.sessions.create({
      id: 's_fail',
      userId: 'u1',
      deviceId: 'd1',
      gatewayId: 'g1',
      agentId: 'claude-code',
      projectId: 'p1',
      projectRoot: '/p1',
      state: 'failed',
      trustProfile: 'default',
      config: { adapter: 'claude-code', projectRoot: '/p1' },
      startedAt: NOW,
    });
    const decision = await router(db, ['codex', 'claude-code']).route('u1', {
      projectId: 'p1',
      taskKind: 'implementation',
    });
    // One failure is not a trend: alphabetical, as with no history at all.
    expect(decision.selected?.agentId).toBe('claude-code');
  });
});

describe('track record', () => {
  it('does not hold a plan limit or a cancellation against an agent', async () => {
    const db = await fixture();
    const session = (id: string, state: 'completed' | 'failed' | 'cancelled', error?: string) =>
      db.sessions.create({
        id,
        userId: 'u1',
        deviceId: 'd1',
        gatewayId: 'g1',
        agentId: 'codex',
        projectId: 'p1',
        projectRoot: '/p1',
        state,
        ...(error ? { error } : {}),
        trustProfile: 'default',
        config: { adapter: 'codex', projectRoot: '/p1' },
        startedAt: NOW,
      });
    await session('s1', 'completed');
    await session('s2', 'failed', "You've hit your usage limit. Try again in 3 hours.");
    await session('s3', 'cancelled');
    await session('s4', 'failed', 'TypeError: cannot read properties of undefined');
    const record = (await new TrackRecords(db, () => NOW.getTime()).forProject('u1', 'p1')).get(
      'codex',
    );
    expect(record).toMatchObject({ successes: 1, failures: 1, samples: 2, score: 0.5 });
  });
});
