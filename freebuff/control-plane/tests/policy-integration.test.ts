import { describe, it, expect, beforeEach } from 'vitest';
import { ControlPlane } from '../src/control-plane';
import { randomUUID } from 'node:crypto';

// Policy integration tests — test the core policy/approval/audit logic
// via the control plane's internal APIs (bypassing HTTP auth checks)

describe('Policy Integration — Core Policy & Approval Logic', () => {
  let cp: ControlPlane;

  beforeEach(async () => {
    cp = new ControlPlane({ port: 0 });
    await cp.start();
  });

  it('evaluate allows LOW-risk filesystem.read with default policy', async () => {
    const result = await cp.policyService.evaluate(
      'filesystem.read',
      'low',
      { deviceId: 'dev_test', sessionId: 'sess_test', userId: 'usr_test' },
    );
    expect(result.decision).toBe('allow');
    expect(result.policyVersion).toBe('p_default');
  });

  it('evaluate denies deployment.execute on production/** via deny floor', async () => {
    const result = await cp.policyService.evaluate(
      'deployment.execute',
      'critical',
      { deviceId: 'dev_test', sessionId: 'sess_test', userId: 'usr_test', resource: 'production/api' },
    );
    expect(result.decision).toBe('deny');
    expect(result.reason).toContain('deny-override floor');
  });

  it('evaluate requires approval for HIGH-risk git.push', async () => {
    const result = await cp.policyService.evaluate(
      'git.push',
      'high',
      { deviceId: 'dev_test', sessionId: 'sess_test', userId: 'usr_test' },
    );
    expect(result.decision).toBe('require_approval');
    expect(result.requiredRole).toBe('admin');
  });

  it('evaluate requires owner approval for CRITICAL-risk', async () => {
    const result = await cp.policyService.evaluate(
      'deployment.execute',
      'critical',
      { deviceId: 'dev_test', sessionId: 'sess_test', userId: 'usr_test', resource: 'staging/api' },
    );
    expect(result.decision).toBe('require_approval');
    expect(result.requiredRole).toBe('owner');
  });

  it('CAS: first decision wins, second gets conflict', async () => {
    const workflow = cp.approvalWorkflow;
    const approval = await workflow.createApproval({
      sessionId: 'sess_cas',
      deviceId: 'dev_cas',
      userId: 'usr_test',
      actionType: 'operation',
      description: 'CAS test',
    });

    const r1 = await workflow.submitDecision(approval.id, 'usr_1', true);
    expect(r1.success).toBe(true);
    expect(r1.record?.status).toBe('granted');

    const r2 = await workflow.submitDecision(approval.id, 'usr_2', false);
    expect(r2.success).toBe(false);
    expect(r2.conflict).toBe(true);
  });

  it('revoked device supersedes pending approvals', async () => {
    const workflow = cp.approvalWorkflow;

    // Create a session first so listAllSessions can find it
    const sessionId = 'sess_rev_test';
    await cp.db.sessions.create({
      id: sessionId,
      userId: 'usr_test',
      deviceId: 'dev_rev',
      gatewayId: 'gw_test',
      agentId: 'mock',
      projectRoot: '/tmp',
      state: 'running',
      config: { agent: 'mock', projectRoot: '/tmp' },
      startedAt: new Date(),
    });

    const approval = await workflow.createApproval({
      sessionId,
      deviceId: 'dev_rev',
      userId: 'usr_test',
      actionType: 'operation',
      description: 'Pre-revocation approval',
    });

    // Simulate device revocation
    await workflow.revokeDeviceApprovals('dev_rev', 'Device revoked');

    const updated = await workflow.getApproval(approval.id);
    expect(updated?.status).toBe('superseded');
    expect(updated?.reason).toContain('Device revoked');
  });

  it('policy change auto-denies pending approval when new policy denies', async () => {
    const workflow = cp.approvalWorkflow;
    const approval = await workflow.createApproval({
      sessionId: 'sess_pc',
      deviceId: 'dev_pc',
      userId: 'usr_test',
      actionType: 'operation',
      description: 'Pre-policy-change approval',
    });

    const result = await workflow.handlePolicyChange(approval.id, 'deny');
    expect(result.actionTaken).toBe('auto_denied');
    const updated = await workflow.getApproval(approval.id);
    expect(updated?.status).toBe('denied');
    expect(updated?.reason).toContain('policy_superseded');
  });

  it('policy change leaves pending approval when new policy allows', async () => {
    const workflow = cp.approvalWorkflow;
    const approval = await workflow.createApproval({
      sessionId: 'sess_pc2',
      deviceId: 'dev_pc2',
      userId: 'usr_test',
      actionType: 'operation',
      description: 'Pre-policy-change approval 2',
    });

    const result = await workflow.handlePolicyChange(approval.id, 'allow');
    expect(result.actionTaken).toBe('none');
    const updated = await workflow.getApproval(approval.id);
    expect(updated?.status).toBe('pending'); // Still pending — human reviewer has it open
  });

  it('expired approval is rejected on decision attempt', async () => {
    const workflow = cp.approvalWorkflow;
    const approval = await workflow.createApproval({
      sessionId: 'sess_exp',
      deviceId: 'dev_exp',
      userId: 'usr_test',
      actionType: 'operation',
      description: 'Expired approval',
      expiresAt: new Date(Date.now() - 60 * 1000), // Expired 1 minute ago
    });

    const result = await workflow.submitDecision(approval.id, 'usr_test', true);
    expect(result.success).toBe(false);
    expect(result.record?.status).toBe('timeout');
  });

  it('policy evaluation is deterministic across calls', async () => {
    // Verify evaluate produces byte-identical results for same inputs
    const r1 = await cp.policyService.evaluate(
      'filesystem.write', 'medium',
      { deviceId: 'dev_test', sessionId: 'sess_test', userId: 'usr_test' },
    );
    const r2 = await cp.policyService.evaluate(
      'filesystem.write', 'medium',
      { deviceId: 'dev_test', sessionId: 'sess_test', userId: 'usr_test' },
    );
    expect(r1.decision).toBe(r2.decision);
    expect(r1.policyVersion).toBe(r2.policyVersion);
  });

  it('read-only trust profile denies write actions', async () => {
    await cp.db.sessions.create({
      id: 'sess_test', userId: 'usr_test', deviceId: 'dev_test', gatewayId: 'gw_test',
      agentId: 'mock', projectRoot: '/tmp', state: 'running', trustProfile: 'read-only',
      config: { adapter: 'mock', projectRoot: '/tmp' }, startedAt: new Date(),
    });
    const result = await cp.policyService.evaluate(
      'filesystem.write',
      'medium',
      { deviceId: 'dev_test', sessionId: 'sess_test', userId: 'usr_test' },
    );
    expect(result.decision).toBe('deny');
  });

  it('supervised profile requires approval for medium-risk actions', async () => {
    await cp.db.sessions.create({
      id: 'sess_test', userId: 'usr_test', deviceId: 'dev_test', gatewayId: 'gw_test',
      agentId: 'mock', projectRoot: '/tmp', state: 'running', trustProfile: 'supervised',
      config: { adapter: 'mock', projectRoot: '/tmp' }, startedAt: new Date(),
    });
    const result = await cp.policyService.evaluate(
      'network.access',
      'medium',
      { deviceId: 'dev_test', sessionId: 'sess_test', userId: 'usr_test' },
    );
    expect(result.decision).toBe('require_approval');
  });

  it('trusted-afk profile allows medium-risk without approval', async () => {
    await cp.db.sessions.create({
      id: 'sess_test', userId: 'usr_test', deviceId: 'dev_test', gatewayId: 'gw_test',
      agentId: 'mock', projectRoot: '/tmp', state: 'running', trustProfile: 'trusted-afk',
      config: { adapter: 'mock', projectRoot: '/tmp' }, startedAt: new Date(),
    });
    const result = await cp.policyService.evaluate(
      'network.access',
      'medium',
      { deviceId: 'dev_test', sessionId: 'sess_test', userId: 'usr_test' },
    );
    expect(result.decision).toBe('allow');
  });

  it('listByUser returns only the user\'s approvals with optional status filter', async () => {
    const workflow = cp.approvalWorkflow;

    await workflow.createApproval({
      sessionId: 'sess_list_1',
      deviceId: 'dev_list',
      userId: 'usr_test',
      actionType: 'operation',
      description: 'Pending for usr_test',
    });
    const decidedApproval = await workflow.createApproval({
      sessionId: 'sess_list_2',
      deviceId: 'dev_list',
      userId: 'usr_test',
      actionType: 'operation',
      description: 'Decided for usr_test',
    });
    await workflow.submitDecision(decidedApproval.id, 'usr_test', true);
    await workflow.createApproval({
      sessionId: 'sess_list_3',
      deviceId: 'dev_list',
      userId: 'usr_other',
      actionType: 'operation',
      description: 'Pending for someone else',
    });

    const all = await cp.db.approvals.listByUser('usr_test');
    expect(all.length).toBe(2);
    expect(all.every((a) => a.userId === 'usr_test')).toBe(true);

    const pendingOnly = await cp.db.approvals.listByUser('usr_test', 'pending');
    expect(pendingOnly.length).toBe(1);
    expect(pendingOnly[0]?.status).toBe('pending');
  });

  it('policy evaluation parity: evaluate produces consistent results', async () => {
    // Test that the evaluate function is deterministic
    const result1 = await cp.policyService.evaluate(
      'filesystem.write',
      'medium',
      { deviceId: 'dev_test', sessionId: 'sess_test', userId: 'usr_test' },
    );

    const result2 = await cp.policyService.evaluate(
      'filesystem.write',
      'medium',
      { deviceId: 'dev_test', sessionId: 'sess_test', userId: 'usr_test' },
    );

    expect(result1.decision).toBe(result2.decision);
    expect(result1.policyVersion).toBe(result2.policyVersion);
  });
});
