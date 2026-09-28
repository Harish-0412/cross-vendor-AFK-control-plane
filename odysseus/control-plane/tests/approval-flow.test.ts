import { WebSocket } from 'ws';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { signJwt } from '../src/auth/jwt';
import { ControlPlane } from '../src/control-plane';
import type { ApprovalRecord } from '../src/types';

import {
  connectAuthenticatedGateway,
  createTestIdentity,
  deviceRecordFor,
} from './helpers/gateway-handshake';

interface GatewayCommand {
  commandType: string;
  payload: Record<string, unknown>;
}

/**
 * Fewer, sharper approvals: what policy already decides is settled on the
 * spot, one tap can remember an approval as a narrow rule, several can be
 * decided at once, and nothing waits forever.
 */
describe('approval flow', () => {
  let cp: ControlPlane;
  let gateway: WebSocket;
  let url: string;
  let token: string;
  let sequence = 0;
  const commands: GatewayCommand[] = [];

  beforeEach(async () => {
    commands.splice(0);
    cp = new ControlPlane({ port: 0, jwtSecret: 'approval-flow-secret' });
    url = (await cp.start()).url;
    await cp.db.users.create({
      id: 'usr_flow',
      email: 'flow@example.test',
      name: 'Flow',
      role: 'owner',
    });
    token = signJwt(
      { sub: 'usr_flow', email: 'flow@example.test', role: 'owner' },
      cp.config.jwtSecret,
      3600,
    );
    const identity = createTestIdentity('dev_flow', 'gw_flow');
    await cp.db.devices.create(deviceRecordFor(identity, { userId: 'usr_flow' }) as never);
    await cp.db.projects.create({
      id: 'proj_flow',
      userId: 'usr_flow',
      name: 'app',
      root: '/work/app',
      preferences: { protectedBranches: ['main'] },
    });
    for (const id of ['sess_flow', 'sess_other'])
      await cp.db.sessions.create({
        id,
        userId: 'usr_flow',
        deviceId: 'dev_flow',
        gatewayId: 'gw_flow',
        agentId: 'opencode',
        projectId: 'proj_flow',
        projectRoot: '/work/app',
        state: 'running',
        trustProfile: 'default',
        config: { adapter: 'opencode', projectRoot: '/work/app' },
        startedAt: new Date(),
      });
    gateway = await connectAuthenticatedGateway(WebSocket as never, cp.getWsTunnelUrl(), identity);
    gateway.on('message', (data) => {
      const message = JSON.parse(data.toString()) as {
        id?: string;
        type?: string;
        payload?: GatewayCommand;
      };
      if (message.type !== 'command' || !message.payload) return;
      commands.push(message.payload);
      // Acknowledge, as the real gateway does, so nothing waits on a timeout.
      gateway.send(
        JSON.stringify({
          id: `ack_${message.id}`,
          type: 'command_result',
          correlationId: message.id,
          timestamp: new Date().toISOString(),
          payload: { success: true },
        }),
      );
    });
  });

  afterEach(async () => {
    gateway.close();
    await cp.stop();
  });

  const headers = () => ({ 'Content-Type': 'application/json', Authorization: `Bearer ${token}` });

  async function waitFor<T>(read: () => Promise<T | undefined> | T | undefined): Promise<T> {
    for (let attempt = 0; attempt < 100; attempt++) {
      const value = await read();
      if (value !== undefined) return value;
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    throw new Error('Timed out waiting');
  }

  async function agentAsks(
    payload: Record<string, unknown>,
    sessionId = 'sess_flow',
  ): Promise<ApprovalRecord> {
    sequence++;
    const before = (await cp.db.approvals.listBySession(sessionId)).length;
    gateway.send(
      JSON.stringify({
        id: `msg_${sequence}`,
        type: 'event',
        sequence,
        timestamp: new Date().toISOString(),
        payload: {
          eventId: `evt_flow_${sequence}`,
          eventType: 'session.approval_required',
          sessionId,
          sequence,
          occurredAt: new Date().toISOString(),
          payload: { approvalId: `agent_appr_${sequence}`, ...payload },
        },
      }),
    );
    return waitFor(async () => {
      const approvals = await cp.db.approvals.listBySession(sessionId);
      return approvals.length > before ? approvals[approvals.length - 1] : undefined;
    });
  }

  const decisionsFor = (approvalId: string) =>
    commands.filter(
      (command) =>
        command.commandType === 'session.approve' && command.payload['approvalId'] === approvalId,
    );

  async function decide(approval: ApprovalRecord, body: Record<string, unknown>) {
    const response = await fetch(
      `${url}/api/v1/sessions/${approval.sessionId}/approvals/${approval.id}/decision`,
      { method: 'POST', headers: headers(), body: JSON.stringify(body) },
    );
    return { status: response.status, body: (await response.json()) as Record<string, unknown> };
  }

  describe('settled on arrival', () => {
    it('lets a low-risk command through without asking, and tells the agent', async () => {
      const approval = await agentAsks({ command: 'pnpm test' });
      expect(approval).toMatchObject({ status: 'granted', decidedBy: 'policy' });
      const sent = await waitFor(() => decisionsFor('agent_appr_' + sequence)[0]);
      expect(sent.payload).toMatchObject({ sessionId: 'sess_flow', decision: 'granted' });
    });

    it('denies what the deny floor forbids, and tells the agent', async () => {
      const approval = await agentAsks({ capability: 'secret.read', resource: '.env' });
      expect(approval).toMatchObject({ status: 'denied', decidedBy: 'policy' });
      const sent = await waitFor(() => decisionsFor('agent_appr_' + sequence)[0]);
      expect(sent.payload['decision']).toBe('denied');
    });

    it('still asks a person when it cannot see what the agent wants to do', async () => {
      const approval = await agentAsks({ actionType: 'tool', description: 'Use a tool' });
      expect(approval.status).toBe('pending');
    });

    it('still asks a person for high-risk work', async () => {
      const approval = await agentAsks({ command: 'git push origin feature/x' });
      expect(approval.status).toBe('pending');
    });
  });

  describe('approve and remember', () => {
    it('stops asking for exactly the same command in the same project', async () => {
      const first = await agentAsks({ command: 'git push origin feature/x' });
      const decision = await decide(first, { approved: true, remember: 'project' });
      expect(decision.status).toBe(200);
      expect(decision.body['remembered']).toMatchObject({
        capability: 'process.exec',
        command: 'git push origin feature/x',
        agentId: 'opencode',
        projectId: 'proj_flow',
        maxRiskLevel: 'high',
      });
      // The agent that asked is told under its own request id.
      expect(decisionsFor(`agent_appr_${sequence}`)[0]?.payload['decision']).toBe('granted');

      const again = await agentAsks({ command: 'git  push origin   feature/x' }, 'sess_other');
      expect(again).toMatchObject({ status: 'granted', decidedBy: 'policy' });
      expect(again.reason).toMatch(/Remembered approval/);
    });

    it('never stretches a rule to a different or riskier command', async () => {
      const first = await agentAsks({ command: 'git push origin feature/x' });
      await decide(first, { approved: true, remember: 'project' });
      expect((await agentAsks({ command: 'git push origin feature/y' })).status).toBe('pending');
      expect((await agentAsks({ command: 'git push --force origin feature/x' })).status).toBe(
        'pending',
      );
    });

    it('keeps a session rule inside its session', async () => {
      const first = await agentAsks({ command: 'git push origin feature/x' });
      await decide(first, { approved: true, remember: 'session' });
      expect((await agentAsks({ command: 'git push origin feature/x' })).status).toBe('granted');
      expect((await agentAsks({ command: 'git push origin feature/x' }, 'sess_other')).status).toBe(
        'pending',
      );
    });

    it('refuses to remember a critical action but still records the approval', async () => {
      const first = await agentAsks({ command: 'git push origin main' });
      const decision = await decide(first, { approved: true, remember: 'project' });
      expect(decision.status).toBe(200);
      expect(decision.body['decision']).toBe('granted');
      expect(decision.body['rememberError']).toMatch(/cannot be remembered/);
    });

    it('never overrides a rule an admin wrote to require approval', async () => {
      const first = await agentAsks({ command: 'git push origin feature/x' });
      await decide(first, { approved: true, remember: 'project' });
      const version = await cp.policyService.createPolicyVersion('usr_flow', 'Always ask', [
        {
          id: 'always-ask-exec',
          description: 'Every command needs a person',
          match: { capability: 'process.exec' },
          effect: 'require_approval',
          priority: 100,
        },
      ]);
      await cp.policyService.activatePolicyVersion(version.id, 'usr_flow');
      const again = await agentAsks({ command: 'git push origin feature/x' });
      expect(again.status).toBe('pending');
      expect(again.matchedRules).toEqual(['always-ask-exec']);
    });

    it('lists and revokes rules', async () => {
      const first = await agentAsks({ command: 'git push origin feature/x' });
      const { body } = await decide(first, { approved: true, remember: 'project' });
      const rule = body['remembered'] as { id: string };

      const listed = (await (
        await fetch(`${url}/api/v1/approvals/remembered`, { headers: headers() })
      ).json()) as Array<{ id: string }>;
      expect(listed.map((item) => item.id)).toEqual([rule.id]);

      const revoked = await fetch(`${url}/api/v1/approvals/remembered/${rule.id}`, {
        method: 'DELETE',
        headers: headers(),
      });
      expect(revoked.status).toBe(200);
      expect((await agentAsks({ command: 'git push origin feature/x' })).status).toBe('pending');
      const audit = await cp.db.audit.list({});
      expect(audit.map((item) => item.action)).toEqual(
        expect.arrayContaining(['approval.remembered', 'approval.remembered_revoked']),
      );
    });
  });

  describe('batch decisions', () => {
    it('approves several at once but leaves critical ones for a separate look', async () => {
      const high = await agentAsks({ command: 'git push origin feature/x' });
      const critical = await agentAsks({ command: 'git push origin main' });
      const response = await fetch(`${url}/api/v1/approvals/decisions`, {
        method: 'POST',
        headers: headers(),
        body: JSON.stringify({
          approvalIds: [high.id, critical.id, 'appr_missing'],
          approved: true,
        }),
      });
      const body = (await response.json()) as {
        decided: number;
        results: Array<Record<string, unknown>>;
      };
      expect(body.decided).toBe(1);
      expect(body.results).toEqual([
        expect.objectContaining({ approvalId: high.id, status: 200, decision: 'granted' }),
        expect.objectContaining({ approvalId: critical.id, status: 422, skipped: true }),
        expect.objectContaining({ approvalId: 'appr_missing', status: 404 }),
      ]);
      expect((await cp.db.approvals.findById(critical.id))?.status).toBe('pending');
    });

    it('denies critical ones in a batch', async () => {
      const critical = await agentAsks({ command: 'git push origin main' });
      const response = await fetch(`${url}/api/v1/approvals/decisions`, {
        method: 'POST',
        headers: headers(),
        body: JSON.stringify({ approvalIds: [critical.id], approved: false }),
      });
      expect(((await response.json()) as { decided: number }).decided).toBe(1);
      expect((await cp.db.approvals.findById(critical.id))?.status).toBe('denied');
    });

    it("cannot touch another user's approvals", async () => {
      const mine = await agentAsks({ command: 'git push origin feature/x' });
      await cp.db.users.create({
        id: 'usr_else',
        email: 'else@example.test',
        name: 'Else',
        role: 'owner',
      });
      const other = signJwt(
        { sub: 'usr_else', email: 'else@example.test', role: 'owner' },
        cp.config.jwtSecret,
        3600,
      );
      const response = await fetch(`${url}/api/v1/approvals/decisions`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${other}` },
        body: JSON.stringify({ approvalIds: [mine.id], approved: true }),
      });
      expect(((await response.json()) as { decided: number }).decided).toBe(0);
      expect((await cp.db.approvals.findById(mine.id))?.status).toBe('pending');
    });
  });

  describe('timeout', () => {
    it('denies an approval nobody decided, and tells the waiting agent', async () => {
      const approval = await agentAsks({ command: 'git push origin feature/x' });
      await cp.db.approvals.update(approval.id, { expiresAt: new Date(Date.now() - 1_000) });
      await cp.escalationScheduler.schedule((await cp.db.approvals.findById(approval.id))!);

      const expired = await waitFor(async () => {
        const record = await cp.db.approvals.findById(approval.id);
        return record?.status === 'timeout' ? record : undefined;
      });
      expect(expired.reason).toMatch(/denied/);
      const sent = await waitFor(() => decisionsFor(`agent_appr_${sequence}`)[0]);
      expect(sent.payload['decision']).toBe('denied');
      await waitFor(async () =>
        (await cp.db.audit.list({ sessionId: 'sess_flow' })).find(
          (item) => item.decision === 'timeout',
        ),
      );
    });

    it('ends an agent-team step that was waiting to start', async () => {
      const approval = await cp.approvalWorkflow.createApproval({
        sessionId: 'sess_other',
        deviceId: 'dev_flow',
        userId: 'usr_flow',
        actionType: 'process.exec',
        description: 'Orchestration step: build',
        details: {
          riskClass: 'high',
          pendingCommand: { commandType: 'session.start', payload: { sessionId: 'sess_other' } },
        },
        expiresAt: new Date(Date.now() + 30),
      });
      await waitFor(async () =>
        (await cp.db.sessions.findById('sess_other'))?.state === 'cancelled' ? true : undefined,
      );
      expect((await cp.db.approvals.findById(approval.id))?.status).toBe('timeout');
      // A held-back command simply never runs; nothing is sent to the gateway.
      expect(commands.filter((command) => command.commandType === 'session.start')).toHaveLength(0);
    });
  });

  it('lists when each pending approval will be denied', async () => {
    await agentAsks({ command: 'git push origin feature/x' });
    const list = (await (
      await fetch(`${url}/api/v1/approvals`, { headers: headers() })
    ).json()) as Array<{ expiresAt: string | null }>;
    expect(Date.parse(list[0]!.expiresAt!)).toBeGreaterThan(Date.now());
  });
});
