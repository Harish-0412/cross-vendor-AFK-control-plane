/**
 * A local Control Plane seeded with approvals, for looking at the Approvals
 * page without a gateway or a real agent.
 *
 *   pnpm exec tsx scripts/demo-approvals.ts
 *
 * Listens on DEMO_PORT (default 4100) with an in-memory database, so nothing
 * it creates outlives the process. It registers a demo account and prints its
 * sign-in details; point the web app at it with NEXT_PUBLIC_API_URL.
 */
import { randomBytes } from 'node:crypto';

import { assessAction } from '../packages/policy-engine/src/index';
import type { ActionDescriptor } from '../packages/protocol/src/index';

import { ControlPlane } from '../control-plane/src/control-plane';
import { MemoryDatabase } from '../control-plane/src/db/memory-store';

const port = Number(process.env['DEMO_PORT'] ?? 4100);
const email = 'demo@odysseus.test';
const password = `Demo-${randomBytes(6).toString('hex')}!`;

async function main(): Promise<void> {
  const cp = new ControlPlane(
    { port, jwtSecret: randomBytes(32).toString('hex') },
    new MemoryDatabase(),
  );
  const { url } = await cp.start();

  const registered = await fetch(`${url}/api/v1/auth/register`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, password, name: 'Demo' }),
  });
  if (!registered.ok) throw new Error(`Could not register the demo account: ${registered.status}`);
  const user = ((await registered.json()) as { user: { id: string } }).user;
  await cp.db.users.update(user.id, { role: 'owner' });

  await cp.db.devices.create({
    id: 'dev_demo',
    userId: user.id,
    gatewayId: 'gw_demo',
    friendlyName: 'Workstation',
    platform: 'linux',
    publicKeyPem: '',
    publicKeyJwk: {},
    fingerprintHex: '',
    fingerprintWords: [],
    status: 'trusted',
    defaultTrustProfile: 'default',
  });
  // Plan windows: Codex reports its own usage; Claude stopped at its limit.
  await cp.db.devices.update('dev_demo', {
    availableAgents: ['claude-code', 'codex', 'opencode'].map((id) => ({ id, capabilities: {} })),
  });
  const inMinutes = (count: number) => new Date(Date.now() + count * 60_000).toISOString();
  await cp.db.providerUsage.upsert({
    deviceId: 'dev_demo',
    userId: user.id,
    integration: 'codex',
    receivedAt: new Date(),
    snapshot: {
      provider: 'codex',
      source: 'codex-rate-limits',
      observedAt: new Date().toISOString(),
      windows: [
        { name: 'primary', usedPercent: 86, windowMinutes: 300, resetsAt: inMinutes(95) },
        { name: 'secondary', usedPercent: 41, windowMinutes: 10_080, resetsAt: inMinutes(4_000) },
      ],
    },
  });
  await cp.db.documents.put('vendor_limits', 'lim_demo', user.id, {
    agentId: 'claude-code',
    deviceId: 'dev_demo',
    detectedAt: new Date().toISOString(),
    resetsAt: inMinutes(130),
    resetKnown: true,
    message: 'Claude AI usage limit reached',
    sessionId: 'sess_demo_claude',
  });

  await cp.db.projects.create({
    id: 'proj_demo',
    userId: user.id,
    name: 'storefront',
    root: '/work/storefront',
    preferences: { protectedBranches: ['main'] },
  });
  for (const [id, agentId] of [
    ['sess_demo_claude', 'claude-code'],
    ['sess_demo_opencode', 'opencode'],
  ] as const)
    await cp.db.sessions.create({
      id,
      userId: user.id,
      deviceId: 'dev_demo',
      gatewayId: 'gw_demo',
      agentId,
      projectId: 'proj_demo',
      projectRoot: '/work/storefront',
      state: 'waiting_for_approval',
      trustProfile: 'default',
      config: { adapter: agentId, projectRoot: '/work/storefront' },
      startedAt: new Date(),
    });

  const ask = async (
    sessionId: string,
    action: ActionDescriptor,
    minutesLeft: number,
    requiredRole?: 'owner' | 'admin',
  ) => {
    const risk = assessAction({
      projectRoot: '/work/storefront',
      protectedBranches: ['main'],
      ...action,
    });
    return cp.approvalWorkflow.createApproval({
      sessionId,
      deviceId: 'dev_demo',
      userId: user.id,
      actionType: action.capability,
      description: risk.summary,
      details: {
        capability: action.capability,
        riskClass: risk.level,
        ...(action.command ? { command: action.command } : {}),
        ...(action.resource ? { resource: action.resource } : {}),
        risk,
      },
      ...(requiredRole ? { requiredRole } : {}),
      expiresAt: new Date(Date.now() + minutesLeft * 60_000),
    });
  };

  await ask(
    'sess_demo_claude',
    { capability: 'process.exec', command: 'git push --force origin main' },
    24,
    'owner',
  );
  await ask(
    'sess_demo_claude',
    { capability: 'process.exec', command: 'git push origin feature/checkout' },
    18,
    'admin',
  );
  await ask(
    'sess_demo_opencode',
    { capability: 'filesystem.write', resource: '.github/workflows/deploy.yml' },
    9,
    'admin',
  );
  await ask(
    'sess_demo_opencode',
    { capability: 'process.exec', command: 'rm -rf src/legacy' },
    3,
    'admin',
  );

  // What the page shows once things are decided.
  const settled = await ask(
    'sess_demo_opencode',
    { capability: 'process.exec', command: 'pnpm test' },
    30,
  );
  await cp.db.approvals.update(settled.id, {
    status: 'granted',
    decidedAt: new Date(),
    decidedBy: 'policy',
    reason: 'Allowed by policy: low risk',
  });
  const remembered = await ask(
    'sess_demo_claude',
    { capability: 'process.exec', command: 'pnpm install' },
    30,
  );
  const granted = await cp.db.approvals.update(remembered.id, {
    status: 'granted',
    decidedAt: new Date(),
    decidedBy: user.id,
    reason: 'Approved by operator',
  });
  const session = await cp.db.sessions.findById('sess_demo_claude');
  if (granted && session) await cp.policyService.remembered.remember(granted, session, 'project');
  const expired = await ask(
    'sess_demo_claude',
    { capability: 'process.exec', command: 'terraform apply' },
    30,
  );
  await cp.db.approvals.update(expired.id, {
    status: 'timeout',
    decidedAt: new Date(),
    decidedBy: 'system',
    reason: 'Nobody decided before the approval expired, so it was denied.',
  });

  // eslint-disable-next-line no-console
  console.log(`\nDemo Control Plane on ${url}\nSign in as ${email} / ${password}\n`);
}

main().catch((error: unknown) => {
  // eslint-disable-next-line no-console
  console.error(error);
  process.exit(1);
});
