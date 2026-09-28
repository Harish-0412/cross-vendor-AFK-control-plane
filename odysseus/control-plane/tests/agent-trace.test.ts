import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { AgentTraceRecord, OdysseusTraceMetadata } from '@odysseus/protocol';

import { signJwt } from '../src/auth/jwt';
import { ControlPlane } from '../src/control-plane';

const DIFF = [
  'diff --git a/src/app.ts b/src/app.ts',
  '--- a/src/app.ts',
  '+++ b/src/app.ts',
  '@@ -1,0 +2,2 @@',
  '+const b = 2;',
  '+const c = 3;',
].join('\n');

describe('Agent Trace records', () => {
  let cp: ControlPlane;
  let url: string;
  let token: string;
  const commands: Array<{ type: string; payload: Record<string, unknown> }> = [];

  beforeEach(async () => {
    commands.splice(0);
    cp = new ControlPlane({
      port: 0,
      jwtSecret: 'agent-trace-secret',
      frontendUrl: 'https://app.example/',
    });
    url = (await cp.start()).url;
    await cp.db.users.create({
      id: 'usr_trace',
      email: 'ada@example.test',
      name: 'Ada',
      role: 'owner',
    });
    token = signJwt(
      { sub: 'usr_trace', email: 'ada@example.test', role: 'owner' },
      cp.config.jwtSecret,
      3600,
    );
    await cp.db.devices.create({
      id: 'dev_trace',
      userId: 'usr_trace',
      gatewayId: 'gw_trace',
      friendlyName: 'Workstation',
      platform: 'linux',
      publicKeyPem: '',
      publicKeyJwk: {},
      fingerprintHex: '',
      fingerprintWords: [],
      status: 'trusted',
      defaultTrustProfile: 'default',
    });
    await cp.db.projects.create({
      id: 'proj_trace',
      userId: 'usr_trace',
      name: 'app',
      root: '/work/app',
      preferences: { protectedBranches: ['main'] },
    });
    await cp.db.sessions.create({
      id: 'sess_trace',
      userId: 'usr_trace',
      deviceId: 'dev_trace',
      gatewayId: 'gw_trace',
      agentId: 'claude-code',
      projectId: 'proj_trace',
      projectRoot: '/work/app',
      state: 'running',
      trustProfile: 'default',
      config: { adapter: 'claude-code', projectRoot: '/work/app' },
      startedAt: new Date(),
    });
    await cp.db.events.append({
      sessionId: 'sess_trace',
      deviceId: 'dev_trace',
      sequence: 1,
      eventType: 'session.started',
      envelope: {
        eventId: 'evt_trace_1',
        eventType: 'session.started',
        eventVersion: 1,
        sessionId: 'sess_trace',
        sequence: 1,
        occurredAt: new Date(),
        payload: { model: 'claude-opus-4-5' },
      } as never,
    });
    const granted = await cp.db.approvals.create({
      sessionId: 'sess_trace',
      deviceId: 'dev_trace',
      userId: 'usr_trace',
      actionType: 'process.exec',
      description: 'Runs `pnpm add zod`',
      details: { riskClass: 'medium' },
      status: 'pending',
    });
    await cp.db.approvals.update(granted.id, {
      status: 'granted',
      decidedBy: 'usr_trace',
      decidedAt: new Date('2026-09-28T09:00:00Z'),
    });
    cp.tunnelServer.sendCommandToDevice = async (_device, type, payload) => {
      commands.push({ type, payload: payload as Record<string, unknown> });
      if (type === 'git.commit')
        return {
          acknowledged: true,
          delivered: true,
          sequence: 1,
          payload: { result: { hash: 'c0ffee'.padEnd(40, '0'), diff: DIFF, diffTruncated: false } },
        };
      return { acknowledged: true, delivered: true, sequence: 1, payload: { success: true } };
    };
  });

  afterEach(async () => cp.stop());
  const headers = () => ({ 'Content-Type': 'application/json', Authorization: `Bearer ${token}` });
  const metadataOf = (record: AgentTraceRecord) =>
    record.metadata?.['dev.odysseus'] as OdysseusTraceMetadata;

  it('records a commit Odysseus makes, and attaches it to the commit as a git note', async () => {
    const response = await fetch(`${url}/api/v1/sessions/sess_trace/git/commit`, {
      method: 'POST',
      headers: headers(),
      body: JSON.stringify({ message: 'feat: add b and c' }),
    });
    expect(response.status).toBe(200);

    for (
      let attempt = 0;
      attempt < 50 && !commands.some((c) => c.type === 'git.trace_note');
      attempt++
    )
      await new Promise((resolve) => setTimeout(resolve, 20));
    const note = commands.find((command) => command.type === 'git.trace_note')!;
    expect(note.payload).toMatchObject({
      projectRoot: '/work/app',
      revision: 'c0ffee'.padEnd(40, '0'),
    });

    const record = note.payload['record'] as AgentTraceRecord;
    expect(record).toMatchObject({
      version: '0.1',
      vcs: { type: 'git', revision: 'c0ffee'.padEnd(40, '0') },
      tool: { name: 'odysseus' },
      files: [
        {
          path: 'src/app.ts',
          conversations: [
            {
              url: 'https://app.example/sessions/sess_trace',
              contributor: { type: 'ai', model_id: 'anthropic/claude-opus-4-5' },
              ranges: [expect.objectContaining({ start_line: 2, end_line: 3 })],
            },
          ],
        },
      ],
    });
    // Who approved what, by name — never an email address.
    expect(metadataOf(record)).toMatchObject({
      sessionId: 'sess_trace',
      agentId: 'claude-code',
      committed: true,
      approvals: [
        { action: 'process.exec', decision: 'granted', decidedBy: 'Ada', riskLevel: 'medium' },
      ],
    });
    expect(JSON.stringify(record)).not.toContain('ada@example.test');

    const listed = (await (
      await fetch(`${url}/api/v1/sessions/sess_trace/agent-trace`, { headers: headers() })
    ).json()) as {
      commits: AgentTraceRecord[];
    };
    expect(listed.commits.map((item) => item.id)).toEqual([record.id]);
  });

  it("builds a record for a session's working tree from its review bundle, once per bundle", async () => {
    await cp.db.sessions.update('sess_trace', {
      reviewBundle: {
        sessionId: 'sess_trace',
        generatedAt: new Date('2026-09-28T10:00:00Z'),
        diff: DIFF,
        summary: {},
        tests: null,
        status: 'ready',
      },
    });
    const read = async () =>
      (await (
        await fetch(`${url}/api/v1/sessions/sess_trace/agent-trace`, { headers: headers() })
      ).json()) as {
        session: AgentTraceRecord;
      };
    const first = (await read()).session;
    expect(first.vcs).toBeUndefined();
    expect(metadataOf(first).committed).toBe(false);
    expect(first.files[0]?.path).toBe('src/app.ts');
    expect((await read()).session.id).toBe(first.id);
  });

  it("does not show another user's session", async () => {
    await cp.db.users.create({
      id: 'usr_other',
      email: 'o@example.test',
      name: 'O',
      role: 'owner',
    });
    const other = signJwt(
      { sub: 'usr_other', email: 'o@example.test', role: 'owner' },
      cp.config.jwtSecret,
      3600,
    );
    const response = await fetch(`${url}/api/v1/sessions/sess_trace/agent-trace`, {
      headers: { Authorization: `Bearer ${other}` },
    });
    expect(response.status).toBe(404);
  });
});
