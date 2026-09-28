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

/**
 * The Control Plane scores what an agent asks to do from the command and path
 * it reports. A gateway may report a higher risk; it can never report a lower
 * one than the Control Plane sees.
 */
describe('risk of agent approval requests', () => {
  let cp: ControlPlane;
  let gateway: WebSocket;
  let url: string;
  let token: string;
  let sequence = 0;

  beforeEach(async () => {
    cp = new ControlPlane({ port: 0, jwtSecret: 'approval-risk-secret' });
    url = (await cp.start()).url;
    await cp.db.users.create({
      id: 'usr_risk',
      email: 'risk@example.test',
      name: 'Risk',
      role: 'owner',
    });
    token = signJwt(
      { sub: 'usr_risk', email: 'risk@example.test', role: 'owner' },
      cp.config.jwtSecret,
      3600,
    );
    const identity = createTestIdentity('dev_risk', 'gw_risk');
    await cp.db.devices.create(deviceRecordFor(identity, { userId: 'usr_risk' }) as never);
    await cp.db.projects.create({
      id: 'proj_risk',
      userId: 'usr_risk',
      name: 'app',
      root: '/work/app',
      preferences: { protectedBranches: ['main', 'release'] },
    });
    await cp.db.sessions.create({
      id: 'sess_risk',
      userId: 'usr_risk',
      deviceId: 'dev_risk',
      gatewayId: 'gw_risk',
      agentId: 'mock',
      projectId: 'proj_risk',
      projectRoot: '/work/app',
      state: 'running',
      trustProfile: 'default',
      config: { adapter: 'mock', projectRoot: '/work/app' },
      startedAt: new Date(),
    });
    gateway = await connectAuthenticatedGateway(WebSocket as never, cp.getWsTunnelUrl(), identity);
  });

  afterEach(async () => {
    gateway.close();
    await cp.stop();
  });

  async function requestApproval(payload: Record<string, unknown>): Promise<ApprovalRecord> {
    sequence++;
    const before = (await cp.db.approvals.listBySession('sess_risk')).length;
    gateway.send(
      JSON.stringify({
        id: `msg_${sequence}`,
        type: 'event',
        sequence,
        timestamp: new Date().toISOString(),
        payload: {
          eventId: `evt_${sequence}`,
          eventType: 'session.approval_required',
          sessionId: 'sess_risk',
          sequence,
          occurredAt: new Date().toISOString(),
          payload,
        },
      }),
    );
    for (let attempt = 0; attempt < 50; attempt++) {
      const approvals = await cp.db.approvals.listBySession('sess_risk');
      if (approvals.length > before) return approvals[approvals.length - 1]!;
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    throw new Error('No approval was recorded');
  }

  it('scores a force-push to main as critical even when the gateway calls it low', async () => {
    const approval = await requestApproval({
      capability: 'process.exec',
      command: 'git push --force origin main',
      riskClass: 'low',
    });
    expect(approval.details?.['riskClass']).toBe('critical');
    expect(approval.requiredRole).toBe('owner');
    expect(approval.description).toMatch(/force-push/);
  });

  it("keeps a gateway's higher risk when it is more cautious than the Control Plane", async () => {
    const approval = await requestApproval({
      capability: 'process.exec',
      command: 'git push origin feature/x',
      riskClass: 'critical',
    });
    expect(approval.details?.['riskClass']).toBe('critical');
  });

  it("treats the project's own protected branches as protected", async () => {
    const approval = await requestApproval({
      action: { type: 'process.exec', command: 'git push origin release' },
    });
    expect(approval.details?.['riskClass']).toBe('critical');
  });

  it('attaches the explained assessment so the approval card can show why', async () => {
    const approval = await requestApproval({ command: 'rm -rf src' });
    const risk = approval.details?.['risk'] as {
      summary: string;
      reversible: boolean;
      factors: unknown[];
    };
    expect(risk.reversible).toBe(false);
    expect(risk.summary).toMatch(/Cannot be undone/);
    expect(risk.factors.length).toBeGreaterThan(1);
  });

  it('scores concrete actions through the dry-run endpoint', async () => {
    const response = await fetch(`${url}/api/v1/risk/assess`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body: JSON.stringify({
        projectId: 'proj_risk',
        action: { capability: 'filesystem.write', resource: '.github/workflows/deploy.yml' },
      }),
    });
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ level: 'high', reversible: true });
  });
});
