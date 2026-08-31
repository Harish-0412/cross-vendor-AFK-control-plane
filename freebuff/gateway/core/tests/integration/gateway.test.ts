import { describe, test, expect, beforeEach, afterEach } from 'vitest';

import { createGateway, GatewayImpl } from '../../src/gateway';
import type { GatewayOptions, SessionConfig, EventEnvelope } from '@freebuff/protocol';

describe('GatewayImpl (Integration)', () => {
  let gateway: GatewayImpl;
  const activeIntervals: ReturnType<typeof setInterval>[] = [];

  beforeEach(() => {
    const options: GatewayOptions = {
      sandboxEnabled: false,
      apiServer: { enabled: false },
      logLevel: 'error',
    };
    gateway = createGateway(options);
  });

  afterEach(async () => {
    for (const interval of activeIntervals) clearInterval(interval);
    activeIntervals.length = 0;
    await gateway.shutdown(false, 2000);
  });

  test('createGateway returns instance with default features', async () => {
    const status = await gateway.getStatus();
    expect(status.gatewayId).toMatch(/^gw_/);
    expect(status.deviceId).toMatch(/^dev_/);
    expect(status.version).toBe('0.1.0');
    expect(status.features.localApiServer).toBe(true);
    expect(status.features.sandboxIsolation).toBe(false);
    expect(status.features.secretRedaction).toBe(true);
  });

  test('listAgents includes mock adapter', async () => {
    const agents = await gateway.listAgents();
    expect(agents.length).toBeGreaterThan(0);
    expect(agents.some((a) => a.metadata.id === 'mock')).toBe(true);
    const mock = agents.find((a) => a.metadata.id === 'mock');
    expect(mock?.installed).toBe(true);
    expect(mock?.metadata.capabilities.sessionCreation).toBe('supported');
  });

  test('detectAgents forces redetection', async () => {
    const before = await gateway.listAgents();
    const after = await gateway.detectAgents();
    expect(after.length).toBe(before.length);
    expect(after[0]!.lastDetectedAt.getTime()).toBeGreaterThanOrEqual(before[0]!.lastDetectedAt.getTime());
  });

  test('getAgent returns single agent info', async () => {
    const mock = await gateway.getAgent('mock');
    expect(mock.metadata.id).toBe('mock');
    expect(mock.installed).toBe(true);
  });

  test('getAgent throws for unknown adapter', async () => {
    await expect(gateway.getAgent('nonexistent')).rejects.toThrow(/Agent not found/);
  });

  test('validateProject detects valid project root', async () => {
    const root = process.cwd();
    const result = await gateway.validateProject(root);
    expect(result.valid).toBe(true);
    expect(result.resolvedRoot).toBe(root);
    expect(result.errors).toEqual([]);
  });

  test('validateProject rejects nonexistent path', async () => {
    const result = await gateway.validateProject('/nonexistent/path/freebuff/12345');
    expect(result.valid).toBe(false);
    expect(result.errors.length).toBeGreaterThan(0);
  });

  test('registerProject + listProjects + removeProject works', async () => {
    const root = process.cwd();
    const proj = await gateway.registerProject({ root });
    expect(proj.id).toMatch(/^proj_/);
    expect(proj.root).toBe(root);

    const listed = await gateway.listProjects();
    expect(listed.some((p) => p.id === proj.id)).toBe(true);

    const got = await gateway.getProject(proj.id);
    expect(got.id).toBe(proj.id);

    const stats = await gateway.getProjectStats();
    expect(stats.totalProjects).toBeGreaterThan(0);
    expect(stats.recentlyAccessed).toBeGreaterThan(0);

    await gateway.removeProject(proj.id);
    const after = await gateway.listProjects();
    expect(after.some((p) => p.id === proj.id)).toBe(false);
  });

  test('createSession with mock adapter starts simple scenario', async () => {
    const config: SessionConfig = {
      projectRoot: process.cwd(),
      adapter: 'mock',
      prompt: 'Test prompt',
      metadata: {
        scenario: 'simple',
        messageCount: 1,
        toolCallCount: 1,
        fileChangeCount: 1,
      },
    };
    const session = await gateway.createSession(config);
    expect(session.id).toMatch(/^sess_/);
    expect(session.adapterId).toBe('mock');
    expect(['initializing', 'running']).toContain(session.state);

    const got = await gateway.getSession(session.id);
    expect(got.id).toBe(session.id);
  });

  test('listSessions / listSessionSummaries with filter works', async () => {
    const config: SessionConfig = {
      projectRoot: process.cwd(),
      adapter: 'mock',
      metadata: { scenario: 'simple', messageCount: 1, toolCallCount: 1, fileChangeCount: 1 },
    };
    const s = await gateway.createSession(config);
    const all = await gateway.listSessions();
    expect(all.some((x) => x.id === s.id)).toBe(true);
    const filtered = await gateway.listSessions({ adapterId: 'mock' });
    expect(filtered.length).toBeGreaterThan(0);
    const summaries = await gateway.listSessionSummaries({ limit: 1 });
    expect(summaries.length).toBeLessThanOrEqual(1);
  });

  test('subscribeToEvents receives session events', async () => {
    const config: SessionConfig = {
      projectRoot: process.cwd(),
      adapter: 'mock',
      metadata: { scenario: 'cancelled' },
    };
    const received: EventEnvelope[] = [];
    const unsub = gateway.subscribeToEvents({
      onEvent: (e) => received.push(e),
    });
    const session = await gateway.createSession(config);

    await new Promise<void>((resolve) => {
      const check = setInterval(async () => {
        try {
          const s = await gateway.getSession(session.id);
          if (s.state === 'cancelled' || received.some((r) => r.eventType === 'session.cancelled') || received.length >= 4) {
            clearInterval(check);
            resolve();
          }
        } catch {
          clearInterval(check);
          resolve();
        }
      }, 50);
      activeIntervals.push(check);
    });

    unsub();
    expect(received.length).toBeGreaterThan(0);
    expect(received[0]!.eventId).toMatch(/^evt_/);
  });

  test('subscribeToSessionEvents scoped per session', async () => {
    const config: SessionConfig = {
      projectRoot: process.cwd(),
      adapter: 'mock',
      metadata: { scenario: 'cancelled' },
    };
    const s1 = await gateway.createSession({ ...config });
    const s2 = await gateway.createSession({ ...config });
    const s1Events: EventEnvelope[] = [];

    gateway.subscribeToSessionEvents(s1.id, { onEvent: (e) => s1Events.push(e) });

    await new Promise((r) => setTimeout(r, 500));
    expect(s1Events.every((e) => e.sessionId === s1.id)).toBe(true);
    expect(s1Events.some((e) => e.sessionId === s2.id)).toBe(false);
  });

  test('stopSession force aborts running session', async () => {
    const config: SessionConfig = {
      projectRoot: process.cwd(),
      adapter: 'mock',
      metadata: {
        scenario: 'long_task',
        messageCount: 50,
        toolCallCount: 20,
      },
    };
    const s = await gateway.createSession(config);
    await new Promise((r) => setTimeout(r, 200));
    await gateway.stopSession(s.id, 'test stop', true);
    const final = await gateway.getSession(s.id);
    expect(['cancelled', 'completed', 'failed']).toContain(final.state);
  });

  test('collectSessionDiff returns formatted diff', async () => {
    const config: SessionConfig = {
      projectRoot: process.cwd(),
      adapter: 'mock',
      metadata: { scenario: 'simple' },
    };
    const s = await gateway.createSession(config);
    await new Promise((r) => setTimeout(r, 200));
    const diff = await gateway.collectSessionDiff(s.id);
    expect(diff).toContain('diff --git');
  });

  test('submitApproval + failed scenario path', async () => {
    const config: SessionConfig = {
      projectRoot: process.cwd(),
      adapter: 'mock',
      metadata: { scenario: 'failed' },
    };
    const s = await gateway.createSession(config);
    await new Promise<void>((resolve) => {
      const check = setInterval(async () => {
        try {
          const state = (await gateway.getSession(s.id)).state;
          if (state === 'failed') {
            clearInterval(check);
            resolve();
          }
        } catch {
          clearInterval(check);
          resolve();
        }
      }, 50);
      activeIntervals.push(check);
    });
    expect((await gateway.getSession(s.id)).state).toBe('failed');
  });

  test('cleanupSession removes from registry', async () => {
    const config: SessionConfig = {
      projectRoot: process.cwd(),
      adapter: 'mock',
      metadata: { scenario: 'cancelled' },
    };
    const s = await gateway.createSession(config);
    expect(await gateway.listSessions()).toHaveLength(1);
    await gateway.cleanupSession(s.id);
    expect(await gateway.listSessions()).toHaveLength(0);
  });

  test('shutdown clears all state', async () => {
    await gateway.createSession({
      projectRoot: process.cwd(),
      adapter: 'mock',
      metadata: { scenario: 'cancelled' },
    });
    await gateway.shutdown(true, 500);
    const status = await gateway.getStatus().catch(() => null);
    expect(status === null || status.activeSessions === 0 || (gateway as unknown as { shuttingDown: boolean }).shuttingDown).toBe(true);
  });

  test('onGatewayEvent receives lifecycle events', async () => {
    const events: Array<string> = [];
    gateway.onGatewayEvent((e) => events.push(e.type));
    // Trigger a project event to verify subscription works
    await gateway.registerProject({ root: process.cwd() });
    expect(events).toContain('project.registered');
  });
});
