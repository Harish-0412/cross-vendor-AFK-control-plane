/**
 * The budgets API as the web app's Budgets page uses it: no scope in the
 * request means the caller's personal organization, which is also where their
 * orchestration runs go, so the budgets the page shows are the ones enforced.
 * The summary is one person's recorded usage over the last 30 days.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { ControlPlane } from '../src/control-plane';
import { spendSummary } from '../src/orchestration/spend-summary';

describe('budgets API', () => {
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
    const token = ((await res.json()) as { accessToken: string }).accessToken;
    return { token, userId: (await cp.db.users.findByEmail(email))!.id };
  }
  async function api(method: string, path: string, token: string, body?: unknown) {
    const res = await fetch(`${base}${path}`, {
      method,
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      ...(body ? { body: JSON.stringify(body) } : {}),
    });
    return { status: res.status, body: await res.json().catch(() => ({})) };
  }

  it('lists nothing, and creates no organization, for someone without budgets', async () => {
    const { token } = await register('budget-new@odysseus.dev');
    expect(await api('GET', '/api/v1/budgets', token)).toEqual({ status: 200, body: [] });
    expect((await api('GET', '/api/v1/organizations', token)).body).toEqual([]);
    expect(await api('GET', '/api/v1/budgets/summary', token)).toMatchObject({
      status: 200,
      body: { days: 30, costUsd: 0, dailyAverageUsd: 0, tokens: 0, subscriptionTokens: 0 },
    });
  });

  it('creates a budget on the personal organization and reports its usage', async () => {
    const owner = await register('budget-owner@odysseus.dev');
    const other = await register('budget-other@odysseus.dev');

    const created = await api('POST', '/api/v1/budgets', owner.token, {
      costLimitUsd: 50,
      tokenLimit: 1_000,
    });
    expect(created.status).toBe(201);
    expect(created.body).toMatchObject({
      scope: 'organization',
      costLimitUsd: 50,
      tokenLimit: 1_000,
      alertPercent: 80,
    });
    const organizations = (await api('GET', '/api/v1/organizations', owner.token)).body;
    expect(organizations).toHaveLength(1);
    const organizationId = organizations[0].id as string;
    expect(created.body.scopeId).toBe(organizationId);

    // A run on a project with no organization lands in the same one, so this
    // is the budget the orchestrator checks before starting each step.
    const project = await api('POST', '/api/v1/projects', owner.token, { root: '/work/shop' });
    const run = await api('POST', '/api/v1/orchestrations', owner.token, {
      projectId: project.body.id,
      goal: 'Add a login endpoint',
    });
    expect(run.body.organizationId).toBe(organizationId);

    await cp.costGovernor.recordUsage({
      sessionId: 'sess_org',
      userId: owner.userId,
      organizationId,
      tokens: 1_200,
      costUsd: 10,
      billing: 'metered',
    });
    // Plan history carries no organization and no dollar cost.
    await cp.costGovernor.recordUsage({
      sessionId: 'hist_plan',
      userId: owner.userId,
      tokens: 500,
      costUsd: 0,
      billing: 'subscription',
    });
    await cp.costGovernor.recordUsage({
      sessionId: 'sess_other',
      userId: other.userId,
      tokens: 9_999,
      costUsd: 99,
    });

    const listed = await api('GET', '/api/v1/budgets', owner.token);
    expect(listed.status).toBe(200);
    expect(listed.body).toHaveLength(1);
    expect(listed.body[0]).toMatchObject({
      scope: 'organization',
      scopeId: organizationId,
      tokens: 1_200,
      costUsd: 10,
      exceeded: true,
      alertTriggered: true,
      limit: { id: created.body.id, costLimitUsd: 50, tokenLimit: 1_000 },
    });
    // The explicit form still works and agrees.
    expect(
      (
        await api(
          'GET',
          `/api/v1/budgets?scope=organization&scopeId=${organizationId}`,
          owner.token,
        )
      ).body,
    ).toEqual(listed.body);

    const summary = await api('GET', '/api/v1/budgets/summary', owner.token);
    expect(summary.status).toBe(200);
    expect(summary.body).toMatchObject({
      days: 30,
      costUsd: 10,
      tokens: 1_700,
      subscriptionTokens: 500,
    });
    expect(summary.body.dailyAverageUsd).toBeCloseTo(10 / 30);

    // Someone else sees neither the budget nor the spend.
    expect(await api('GET', '/api/v1/budgets', other.token)).toEqual({ status: 200, body: [] });
    expect(
      (
        await api(
          'GET',
          `/api/v1/budgets?scope=organization&scopeId=${organizationId}`,
          other.token,
        )
      ).status,
    ).toBe(404);
    expect((await api('GET', '/api/v1/budgets/summary', other.token)).body).toMatchObject({
      costUsd: 99,
      tokens: 9_999,
    });

    // Usage older than the window drops out of the summary.
    const later = new Date(Date.now() + 31 * 24 * 60 * 60 * 1000);
    expect(await spendSummary(cp.db, owner.userId, later)).toMatchObject({
      costUsd: 0,
      tokens: 0,
    });
  });

  it('rejects a budget without a usable limit, before creating an organization', async () => {
    const { token } = await register('budget-invalid@odysseus.dev');
    for (const body of [
      {},
      { costLimitUsd: 0 },
      { tokenLimit: -5 },
      { costLimitUsd: '20' },
      { costLimitUsd: 20, tokenLimit: 'lots' },
      { costLimitUsd: 20, alertPercent: 150 },
      { costLimitUsd: 20, scope: 'organization' },
    ])
      expect((await api('POST', '/api/v1/budgets', token, body)).status).toBe(400);
    expect((await api('GET', '/api/v1/organizations', token)).body).toEqual([]);
  });

  it('requires a signed-in caller', async () => {
    for (const path of ['/api/v1/budgets', '/api/v1/budgets/summary'])
      expect((await fetch(`${base}${path}`)).status).toBe(401);
  });
});
