/**
 * The orchestration API as the web app uses it, against a real Control Plane:
 * starting a run from a goal alone (no organization to set up first), listing,
 * cancelling, and keeping other accounts out. Also the tunnel rule the
 * orchestrator depends on — a bare `session.completed` event finishes the
 * session, because not every adapter also sends `session.status_changed`.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { WebSocket } from 'ws';

import { ControlPlane } from '../src/control-plane';

import { createTestIdentity, deviceRecordFor, performHandshake } from './helpers/gateway-handshake';

describe('orchestration API', () => {
  let cp: ControlPlane;
  let base: string;

  beforeEach(async () => {
    cp = new ControlPlane({ port: 0 });
    await cp.start();
    base = cp.getUrl();
  });
  afterEach(async () => {
    await cp.stop();
  });

  async function register(email: string) {
    const res = await fetch(`${base}/api/v1/auth/register`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email, password: 'Password123!' }),
    });
    return ((await res.json()) as { accessToken: string }).accessToken;
  }
  async function api(method: string, path: string, token: string, body?: unknown) {
    const res = await fetch(`${base}${path}`, {
      method,
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      ...(body ? { body: JSON.stringify(body) } : {}),
    });
    return { status: res.status, body: await res.json().catch(() => ({})) };
  }

  it('starts a planned run from a goal, lists it, keeps others out and cancels it', async () => {
    const owner = await register('orch-owner@odysseus.dev');
    const other = await register('orch-other@odysseus.dev');
    const project = await api('POST', '/api/v1/projects', owner, {
      root: '/work/shop',
      name: 'shop',
    });
    expect(project.status).toBe(201);

    const created = await api('POST', '/api/v1/orchestrations', owner, {
      projectId: project.body.id,
      goal: 'Add a login endpoint',
    });
    expect(created.status).toBe(201);
    // No machine is online, so the planner waits rather than failing.
    expect(created.body.goal).toBe('Add a login endpoint');
    expect(created.body.plan.steps[0]).toMatchObject({
      id: 'plan',
      taskKind: 'planning',
      state: 'blocked',
    });

    const listed = await api('GET', `/api/v1/orchestrations?projectId=${project.body.id}`, owner);
    expect(listed.body.map((run: { id: string }) => run.id)).toEqual([created.body.id]);

    expect((await api('GET', `/api/v1/orchestrations/${created.body.id}`, other)).status).toBe(404);
    expect((await api('GET', '/api/v1/orchestrations', other)).body).toEqual([]);
    expect(
      (
        await api('POST', '/api/v1/orchestrations', other, {
          projectId: project.body.id,
          goal: 'x',
        })
      ).status,
    ).toBe(404);

    const cancelled = await api('POST', `/api/v1/orchestrations/${created.body.id}/cancel`, owner);
    expect(cancelled.body.state).toBe('cancelled');
  });

  it('rejects a request with neither a goal nor steps', async () => {
    const owner = await register('orch-empty@odysseus.dev');
    const project = await api('POST', '/api/v1/projects', owner, { root: '/work/empty' });
    expect(
      (await api('POST', '/api/v1/orchestrations', owner, { projectId: project.body.id })).status,
    ).toBe(400);
  });

  it('marks a session completed from a bare session.completed event', async () => {
    const token = await register('orch-events@odysseus.dev');
    const user = (await cp.db.users.findByEmail('orch-events@odysseus.dev'))!;
    const identity = createTestIdentity('dev_orch_events', 'gw_orch_events');
    await cp.db.devices.create(deviceRecordFor(identity, { userId: user.id }) as never);
    await cp.db.sessions.create({
      id: 'sess_bare_complete',
      userId: user.id,
      deviceId: identity.deviceId,
      gatewayId: identity.gatewayId,
      agentId: 'opencode',
      projectRoot: '/work',
      state: 'running',
      trustProfile: 'default',
      config: { projectRoot: '/work', adapter: 'opencode' },
      startedAt: new Date(),
    });
    expect(token).toBeTruthy();

    const socket = new WebSocket(cp.getWsTunnelUrl());
    await new Promise<void>((resolve) => socket.on('open', () => resolve()));
    expect((await performHandshake(socket, identity)).ok).toBe(true);
    socket.send(
      JSON.stringify({
        id: 'msg_done',
        type: 'event',
        sequence: 5,
        timestamp: new Date().toISOString(),
        payload: {
          eventId: 'evt_done_1',
          eventType: 'session.completed',
          sessionId: 'sess_bare_complete',
          sequence: 1,
          occurredAt: new Date().toISOString(),
          payload: {},
        },
      }),
    );
    const deadline = Date.now() + 3000;
    let state = '';
    while (Date.now() < deadline) {
      state = (await cp.db.sessions.findById('sess_bare_complete'))?.state ?? '';
      if (state === 'completed') break;
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    expect(state).toBe('completed');
    socket.close();
  });
});
