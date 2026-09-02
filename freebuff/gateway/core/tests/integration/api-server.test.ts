import type { GatewayOptions } from '@freebuff/protocol';
import { describe, test, expect, beforeEach, afterEach } from 'vitest';

import { createApiServer, type LocalApiServer } from '../../src/api-server';
import { createGateway, type GatewayImpl } from '../../src/gateway';

describe('LocalApiServer (Integration)', () => {
  let gateway: GatewayImpl;
  let server: LocalApiServer;
  let baseUrl: string;

  beforeEach(async () => {
    const options: GatewayOptions = {
      sandboxEnabled: false,
      apiServer: { enabled: false },
      logLevel: 'error',
    };
    gateway = createGateway(options);
    server = createApiServer(gateway, { host: '127.0.0.1', port: 0 });
    const status = await server.start();
    baseUrl = status.url;
  });

  afterEach(async () => {
    await server.stop(500);
    await gateway.shutdown(false, 500);
  });

  async function fetchJson(path: string, init?: RequestInit) {
    const res = await fetch(`${baseUrl}${path}`, init);
    const text = await res.text();
    let json: unknown = null;
    if (text) {
      try {
        json = JSON.parse(text);
      } catch {
        /* ignore */
      }
    }
    return {
      status: res.status,
      body: json,
      headers: Object.fromEntries(res.headers.entries()),
      text,
    };
  }

  test('GET / returns API info', async () => {
    const res = await fetchJson('/');
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ name: 'Freebuff Gateway API', version: '0.1.0' });
  });

  test('GET /health returns ok', async () => {
    const res = await fetchJson('/health');
    expect(res.status).toBe(200);
    expect((res.body as { status: string }).status).toBe('ok');
  });

  test('GET /status returns gateway status', async () => {
    const res = await fetchJson('/status');
    expect(res.status).toBe(200);
    const body = res.body as { gatewayId: string; activeSessions: number };
    expect(body.gatewayId).toMatch(/^gw_/);
    expect(typeof body.activeSessions).toBe('number');
  });

  test('GET /agents lists mock adapter', async () => {
    const res = await fetchJson('/agents');
    expect(res.status).toBe(200);
    const agents = res.body as Array<{ metadata: { id: string } }>;
    expect(agents.some((a) => a.metadata.id === 'mock')).toBe(true);
  });

  test('POST /agents/detect forces detect', async () => {
    const res = await fetchJson('/agents/detect', { method: 'POST' });
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body)).toBe(true);
  });

  test('GET /agents/:id returns single agent', async () => {
    const res = await fetchJson('/agents/mock');
    expect(res.status).toBe(200);
    expect((res.body as { metadata: { id: string } }).metadata.id).toBe('mock');
  });

  test('POST /projects/validate validates a root', async () => {
    const res = await fetchJson('/projects/validate', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ root: process.cwd() }),
    });
    expect(res.status).toBe(200);
    expect((res.body as { valid: boolean }).valid).toBe(true);
  });

  test('POST /projects/validate returns errors for invalid root', async () => {
    const res = await fetchJson('/projects/validate', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ root: '/not/a/real/path/freebuff' }),
    });
    expect(res.status).toBe(200);
    expect((res.body as { valid: boolean }).valid).toBe(false);
  });

  test('POST /projects registers a project', async () => {
    const res = await fetchJson('/projects', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ root: process.cwd() }),
    });
    expect(res.status).toBe(201);
    const id = (res.body as { id: string }).id;
    expect(id).toMatch(/^proj_/);

    const list = await fetchJson('/projects');
    expect((list.body as Array<{ id: string }>).some((p) => p.id === id)).toBe(true);

    const del = await fetchJson(`/projects/${id}`, { method: 'DELETE' });
    expect(del.status).toBe(204);
  });

  test('GET /projects/stats returns stats', async () => {
    const res = await fetchJson('/projects/stats');
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ totalProjects: expect.any(Number), activeSessions: 0 });
  });

  test('POST /sessions creates session', async () => {
    const res = await fetchJson('/sessions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        projectRoot: process.cwd(),
        adapter: 'mock',
        metadata: { scenario: 'cancelled' },
      }),
    });
    expect(res.status).toBe(201);
    const id = (res.body as { id: string }).id;
    expect(id).toMatch(/^sess_/);

    const got = await fetchJson(`/sessions/${id}`);
    expect(got.status).toBe(200);
    expect((got.body as { id: string }).id).toBe(id);

    const diff = await fetchJson(`/sessions/${id}/diff`);
    expect(diff.status).toBe(200);
    expect(typeof (diff.body as { diff: string }).diff).toBe('string');
  });

  test('GET /sessions returns sessions', async () => {
    await fetchJson('/sessions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        projectRoot: process.cwd(),
        adapter: 'mock',
        metadata: { scenario: 'cancelled' },
      }),
    });
    const res = await fetchJson('/sessions');
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body)).toBe(true);
    expect((res.body as unknown[]).length).toBeGreaterThan(0);
  });

  test('GET /sessions?summaries=true returns summaries', async () => {
    await fetchJson('/sessions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        projectRoot: process.cwd(),
        adapter: 'mock',
        metadata: { scenario: 'cancelled' },
      }),
    });
    const res = await fetchJson('/sessions?summaries=true');
    expect(res.status).toBe(200);
    const first = (res.body as Array<{ eventCount: number }>)[0];
    expect(typeof first.eventCount).toBe('number');
  });

  test('DELETE /sessions/:id stops session', async () => {
    const created = await fetchJson('/sessions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        projectRoot: process.cwd(),
        adapter: 'mock',
        metadata: { scenario: 'long_task', messageCount: 20, toolCallCount: 10 },
      }),
    });
    const id = (created.body as { id: string }).id;
    await new Promise((r) => setTimeout(r, 100));

    const res = await fetchJson(`/sessions/${id}`, {
      method: 'DELETE',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ reason: 'api stop', force: true }),
    });
    expect(res.status).toBe(204);
  });

  test('DELETE /sessions/:id/cleanup removes session', async () => {
    const created = await fetchJson('/sessions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        projectRoot: process.cwd(),
        adapter: 'mock',
        metadata: { scenario: 'cancelled' },
      }),
    });
    const id = (created.body as { id: string }).id;
    await new Promise((r) => setTimeout(r, 200));
    const res = await fetchJson(`/sessions/${id}/cleanup`, { method: 'DELETE' });
    expect(res.status).toBe(204);
  });

  test('POST /sessions/:id/messages sends message', async () => {
    const created = await fetchJson('/sessions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        projectRoot: process.cwd(),
        adapter: 'mock',
        metadata: { scenario: 'simple' },
      }),
    });
    const id = (created.body as { id: string }).id;
    const res = await fetchJson(`/sessions/${id}/messages`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ message: 'Hello from API test' }),
    });
    expect(res.status).toBe(202);
  });

  test('404 for unknown paths', async () => {
    const res = await fetchJson('/this-does-not-exist');
    expect(res.status).toBe(404);
    expect(
      ((res.body as { error?: { message: string } }).error?.message ?? '').toLowerCase(),
    ).toContain('not found');
  });

  test('Unknown adapter returns 404 on session create', async () => {
    const res = await fetchJson('/sessions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ projectRoot: process.cwd(), adapter: 'nonexistent-adapter' }),
    });
    expect(res.status).toBe(404);
  });
});
