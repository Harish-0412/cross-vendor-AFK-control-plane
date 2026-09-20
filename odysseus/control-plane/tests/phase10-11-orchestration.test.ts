import { describe, expect, it } from 'vitest';
import type { AgentInfo } from '@odysseus/protocol';
import { MemoryDatabase } from '../src/db/memory-store';
import { AgentRouter } from '../src/orchestration/agent-router';
import { CostGovernor } from '../src/orchestration/cost-governor';
import { RiskEngine } from '../src/orchestration/risk-engine';
import { MultiAgentOrchestrator } from '../src/orchestration/multi-agent-orchestrator';
import type { ConnectionRegistry } from '../src/tunnel/connection-registry';
import type { TunnelServer } from '../src/tunnel/tunnel-server';
import type { PolicyEngineService } from '../src/policy/policy-engine-service';
import type { ApprovalWorkflow } from '../src/policy/approval-workflow';

const caps = (approvalInterception: 'supported' | 'partial' | 'unsupported') =>
  ({
    sessionCreation: 'supported',
    promptDelivery: 'supported',
    streaming: 'supported',
    cancellation: 'supported',
    diffCollection: 'supported',
    approvalInterception,
    checkpointRecovery: 'supported',
    multiTurn: 'supported',
    fileOperations: 'supported',
    toolExecution: 'supported',
  }) as const;
const agent = (
  id: string,
  approvalInterception: 'supported' | 'partial' | 'unsupported',
): AgentInfo => ({
  metadata: {
    id,
    name: id,
    version: '1',
    platform: ['linux'],
    capabilities: caps(approvalInterception),
  },
  installed: true,
  health: { status: 'healthy', lastCheckAt: new Date() },
  lastDetectedAt: new Date(),
});

async function fixture(): Promise<MemoryDatabase> {
  const db = new MemoryDatabase();
  await db.users.create({ id: 'u1', email: 'u1@example.test', name: 'u1', role: 'owner' });
  for (const id of ['d1', 'd2'])
    await db.devices.create({
      id,
      userId: 'u1',
      gatewayId: `g_${id}`,
      friendlyName: id,
      platform: 'linux',
      publicKeyPem: '',
      publicKeyJwk: {},
      fingerprintHex: '',
      fingerprintWords: [],
      status: 'trusted',
      defaultTrustProfile: 'default',
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

describe('Phases 10-11 multi-machine governance', () => {
  it('routes to the least-loaded eligible gateway and prefers interceptable adapters for lowest risk', async () => {
    const db = await fixture();
    // The router selects on isDeviceAcceptingSessions (online AND not
    // draining), so the fake has to answer that too.
    const registry = {
      isDeviceOnline: () => true,
      isDeviceAcceptingSessions: () => true,
      getAdmissionPhase: () => 'running' as const,
    } as unknown as ConnectionRegistry;
    const tunnel = {
      sendCommandToDevice: async (deviceId: string) => ({
        delivered: true,
        acknowledged: true,
        payload: {
          result: {
            agents: [
              agent(
                deviceId === 'd1' ? 'opencode' : 'codex',
                deviceId === 'd1' ? 'unsupported' : 'supported',
              ),
            ],
            activeSessions: deviceId === 'd1' ? 0 : 2,
          },
        },
      }),
    } as unknown as TunnelServer;
    const router = new AgentRouter(db, registry, tunnel);
    expect(
      (await router.route('u1', { projectId: 'p1', taskKind: 'test', strategy: 'least_loaded' }))
        .selected?.deviceId,
    ).toBe('d1');
    expect(
      (
        await router.route('u1', {
          projectId: 'p1',
          taskKind: 'implementation',
          strategy: 'lowest_risk',
        })
      ).selected?.deviceId,
    ).toBe('d2');
  });

  it('scores high-risk production work explainably and enforces organization budgets', async () => {
    const risk = new RiskEngine().assess({
      taskKind: 'implementation',
      prompt: 'deploy production release',
      protectedProject: true,
    });
    expect(risk).toMatchObject({ level: 'critical', requiresApproval: true });
    expect(risk.factors.map((item) => item.name)).toContain('production-keyword');
    const db = await fixture();
    const governor = new CostGovernor(db);
    await governor.setBudget({
      scope: 'organization',
      scopeId: 'org1',
      tokenLimit: 10,
      alertPercent: 50,
    });
    const usage = await governor.recordUsage({
      sessionId: 's1',
      userId: 'u1',
      projectId: 'p1',
      organizationId: 'org1',
      tokens: 11,
      costUsd: 0,
    });
    expect(usage.find((item) => item.scope === 'organization')).toMatchObject({
      exceeded: true,
      tokens: 11,
    });
  });

  it('starts independent DAG steps without gateway-specific branching and rejects cycles', async () => {
    const db = await fixture();
    const org = await db.organizations.create({ id: 'org1', name: 'org', ownerId: 'u1' });
    await db.projects.update('p1', { organizationId: org.id });
    const router = {
      route: async () => ({
        id: 'r1',
        request: { projectId: 'p1', taskKind: 'test' },
        selected: {
          deviceId: 'd1',
          gatewayId: 'g_d1',
          agentId: 'opencode',
          online: true,
          activeSessions: 0,
        },
        alternatives: [],
        reasons: [],
        createdAt: new Date(),
      }),
    } as unknown as AgentRouter;
    const tunnel = {
      sendCommandToDevice: async () => ({ delivered: true, acknowledged: true, payload: {} }),
    } as unknown as TunnelServer;
    const policy = {
      evaluate: async () => ({ decision: 'allow', policyVersion: 'v1', matchedRules: [] }),
    } as unknown as PolicyEngineService;
    const approvals = {
      createApproval: async () => {
        throw new Error('not expected');
      },
    } as unknown as ApprovalWorkflow;
    const orchestrator = new MultiAgentOrchestrator(db, tunnel, policy, approvals, router);
    const run = await orchestrator.createRun({
      organizationId: org.id,
      userId: 'u1',
      projectId: 'p1',
      title: 'parallel',
      steps: [
        { id: 'plan', title: 'Plan', taskKind: 'planning', prompt: 'plan', dependsOn: [] },
        { id: 'test', title: 'Test', taskKind: 'test', prompt: 'test', dependsOn: [] },
      ],
    });
    expect(run.plan.steps.map((step) => step.state)).toEqual(['running', 'running']);
    await expect(
      orchestrator.createRun({
        organizationId: org.id,
        userId: 'u1',
        projectId: 'p1',
        title: 'cycle',
        steps: [
          { id: 'a', title: 'A', taskKind: 'test', prompt: 'a', dependsOn: ['b'] },
          { id: 'b', title: 'B', taskKind: 'test', prompt: 'b', dependsOn: ['a'] },
        ],
      }),
    ).rejects.toThrow('cycle');
  });
});
