import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ControlPlane } from '../src/control-plane';
import { signJwt } from '../src/auth/jwt';

describe('Phase 9 Git API and project dashboard', () => {
  let cp: ControlPlane;
  let url: string;
  let token: string;
  const commands: Array<{ type: string; payload: unknown }> = [];

  beforeEach(async () => {
    commands.splice(0);
    cp = new ControlPlane({ port: 0, jwtSecret: 'phase9-test-secret' });
    url = (await cp.start()).url;
    await cp.db.users.create({ id: 'usr_phase9', email: 'phase9@example.test', name: 'Phase 9', role: 'owner' });
    token = signJwt({ sub: 'usr_phase9', email: 'phase9@example.test', role: 'owner' }, cp.config.jwtSecret, 3600);
    await cp.db.devices.create({ id: 'dev_phase9', userId: 'usr_phase9', gatewayId: 'gw_phase9', friendlyName: 'test', platform: 'linux', publicKeyPem: '', publicKeyJwk: {}, fingerprintHex: '', fingerprintWords: [], status: 'trusted', defaultTrustProfile: 'default' });
    await cp.db.projects.create({ id: 'proj_phase9_a', userId: 'usr_phase9', name: 'A', root: 'C:\\projects\\a', preferences: { protectedBranches: ['main'] } });
    await cp.db.projects.create({ id: 'proj_phase9_b', userId: 'usr_phase9', name: 'B', root: 'C:\\projects\\b', preferences: { protectedBranches: ['main'] } });
    await cp.db.sessions.create({ id: 'sess_phase9_a', userId: 'usr_phase9', deviceId: 'dev_phase9', gatewayId: 'gw_phase9', agentId: 'mock', projectId: 'proj_phase9_a', projectRoot: 'C:\\projects\\a', state: 'running', trustProfile: 'default', config: { adapter: 'mock', projectRoot: 'C:\\projects\\a' }, startedAt: new Date() });
    await cp.db.sessions.create({ id: 'sess_phase9_b', userId: 'usr_phase9', deviceId: 'dev_phase9', gatewayId: 'gw_phase9', agentId: 'opencode', projectId: 'proj_phase9_b', projectRoot: 'C:\\projects\\b', state: 'running', trustProfile: 'default', config: { adapter: 'opencode', projectRoot: 'C:\\projects\\b' }, startedAt: new Date() });
    cp.tunnelServer.sendCommandToDevice = async (_device, type, payload) => {
      commands.push({ type, payload });
      return { acknowledged: true, delivered: true, sequence: 1, payload: { success: true } };
    };
  });

  afterEach(async () => cp.stop());
  const headers = () => ({ 'Content-Type': 'application/json', Authorization: `Bearer ${token}` });

  it('defers HIGH-risk push and dispatches its exact command only after approval', async () => {
    const push = await fetch(`${url}/api/v1/sessions/sess_phase9_a/git/push`, {
      method: 'POST', headers: headers(), body: JSON.stringify({ branch: 'feature/review', remote: 'origin' }),
    });
    expect(push.status).toBe(202);
    expect(commands).toHaveLength(0);
    const approval = (await push.json() as { approval: { id: string } }).approval;
    const decision = await fetch(`${url}/api/v1/sessions/sess_phase9_a/approvals/${approval.id}/decision`, {
      method: 'POST', headers: headers(), body: JSON.stringify({ approved: true }),
    });
    expect(decision.status).toBe(200);
    expect(commands[0]).toMatchObject({ type: 'git.push', payload: { sessionId: 'sess_phase9_a', branch: 'feature/review', remote: 'origin', force: false } });
    const audit = await cp.db.audit.list({ sessionId: 'sess_phase9_a' });
    expect(audit.map((item) => [item.action, item.decision])).toContainEqual(['git.push', 'require_approval']);
    expect(audit.map((item) => [item.action, item.decision])).toContainEqual(['git.push.approval_granted', 'granted']);
  });

  it('enforces the force-push deny floor before tunnel delivery', async () => {
    const response = await fetch(`${url}/api/v1/sessions/sess_phase9_a/git/push`, {
      method: 'POST', headers: headers(), body: JSON.stringify({ branch: 'main', force: true }),
    });
    expect(response.status).toBe(403);
    expect(commands).toHaveLength(0);
  });

  it('isolates dashboard aggregation to one project', async () => {
    await cp.db.events.append({ sessionId: 'sess_phase9_a', deviceId: 'dev_phase9', sequence: 1, eventType: 'session.output', envelope: { eventId: 'evt_a', eventType: 'session.output', eventVersion: 1, sessionId: 'sess_phase9_a', sequence: 1, timestamp: new Date(), source: { gatewayId: 'gw_phase9', agentId: 'mock' }, payload: { marker: 'ONLY_A' } } });
    await cp.db.events.append({ sessionId: 'sess_phase9_b', deviceId: 'dev_phase9', sequence: 1, eventType: 'session.output', envelope: { eventId: 'evt_b', eventType: 'session.output', eventVersion: 1, sessionId: 'sess_phase9_b', sequence: 1, timestamp: new Date(), source: { gatewayId: 'gw_phase9', agentId: 'opencode' }, payload: { marker: 'SECRET_B' } } });
    const response = await fetch(`${url}/api/v1/projects/proj_phase9_a/dashboard`, { headers: headers() });
    expect(response.status).toBe(200);
    const text = await response.text();
    expect(text).toContain('ONLY_A');
    expect(text).not.toContain('SECRET_B');
    expect(text).not.toContain('sess_phase9_b');
  });

  it('assembles two active sessions, completed history, and only project-scoped policy', async () => {
    await cp.db.sessions.create({ id: 'sess_phase9_a2', userId: 'usr_phase9', deviceId: 'dev_phase9', gatewayId: 'gw_phase9', agentId: 'opencode', projectId: 'proj_phase9_a', projectRoot: 'C:\\projects\\a', state: 'paused', trustProfile: 'default', config: { adapter: 'opencode', projectRoot: 'C:\\projects\\a' }, startedAt: new Date() });
    await cp.db.sessions.create({ id: 'sess_phase9_a3', userId: 'usr_phase9', deviceId: 'dev_phase9', gatewayId: 'gw_phase9', agentId: 'mock', projectId: 'proj_phase9_a', projectRoot: 'C:\\projects\\a', state: 'completed', trustProfile: 'default', config: { adapter: 'mock', projectRoot: 'C:\\projects\\a' }, startedAt: new Date(), completedAt: new Date() });
    const policy = await cp.policyService.createPolicyVersion('usr_phase9', 'dashboard', [
      { id: 'rule_a', description: 'A only', match: { projectId: 'proj_phase9_a', capability: 'git.commit' }, effect: 'allow', priority: 1 },
      { id: 'rule_b', description: 'B only', match: { projectId: 'proj_phase9_b', capability: 'git.commit' }, effect: 'deny', priority: 1 },
    ]);
    await cp.policyService.activatePolicyVersion(policy.id, 'usr_phase9');
    const response = await fetch(`${url}/api/v1/projects/proj_phase9_a/dashboard`, { headers: headers() });
    const dashboard = await response.json() as { activeSessions: unknown[]; history: Array<{ item: { id?: string } }>; policies: Array<{ id: string }>; workspace: { root: string } };
    expect(dashboard.activeSessions).toHaveLength(2);
    expect(dashboard.history.some((entry) => entry.item.id === 'sess_phase9_a3')).toBe(true);
    expect(dashboard.policies.map((rule) => rule.id)).toEqual(['rule_a']);
    expect(dashboard.workspace.root).toBe('C:\\projects\\a');
  });
});
