import { describe, expect, it } from 'vitest';
import { MemoryDatabase } from '../src/db/memory-store';
import { ReviewOrchestrator } from '../src/review/review-orchestrator';
import type { TunnelServer } from '../src/tunnel/tunnel-server';
import type { PolicyEngineService } from '../src/policy/policy-engine-service';

async function session(db: MemoryDatabase): Promise<void> {
  await db.sessions.create({ id: 'sess_review', userId: 'usr_1', deviceId: 'dev_1', gatewayId: 'gw_1', agentId: 'mock', projectId: 'proj_1', projectRoot: '/workspace', state: 'completed', trustProfile: 'default', config: { projectRoot: '/workspace', adapter: 'mock' }, startedAt: new Date() });
}

describe('Phase 9 review orchestration', () => {
  it('keeps the exact diff and distinguishes one failing test from collection failure', async () => {
    const db = new MemoryDatabase();
    await session(db);
    const exactDiff = 'diff --git a/a.ts b/a.ts\n-old\n+new\n';
    const tunnel = { sendCommandToDevice: async (_device: string, type: string) => ({ delivered: true, acknowledged: true, sequence: 1, payload: { success: true, result: type === 'session.diff_collection' ? { diff: exactDiff } : { command: ['pnpm', 'test'], passed: false, exitCode: 1, stdout: '2 passed, 1 failed', stderr: '' } } }) } as unknown as TunnelServer;
    const policy = { evaluate: async () => ({ decision: 'allow', policyVersion: 'test' }) } as unknown as PolicyEngineService;
    const bundle = await new ReviewOrchestrator(db, tunnel, policy).build('sess_review');
    expect(bundle.diff).toBe(exactDiff);
    expect(bundle.tests?.stdout).toContain('1 failed');
    expect(bundle.status).toBe('tests_failed');
    expect(JSON.stringify(bundle.summary)).toContain('Review tests failed');
    expect((await db.sessions.findById('sess_review'))?.reviewBundle).toEqual(bundle);
  });

  it('reports policy denial separately and never executes tests', async () => {
    const db = new MemoryDatabase();
    await session(db);
    const calls: string[] = [];
    const tunnel = { sendCommandToDevice: async (_device: string, type: string) => { calls.push(type); return { delivered: true, acknowledged: true, sequence: 1, payload: { result: { diff: 'exact' } } }; } } as unknown as TunnelServer;
    const policy = { evaluate: async () => ({ decision: 'deny', policyVersion: 'test', reason: 'locked' }) } as unknown as PolicyEngineService;
    const bundle = await new ReviewOrchestrator(db, tunnel, policy).build('sess_review');
    expect(bundle.status).toBe('blocked_by_policy');
    expect(bundle.policyDenial).toBe('locked');
    expect(calls).toEqual(['session.diff_collection']);
  });
});
