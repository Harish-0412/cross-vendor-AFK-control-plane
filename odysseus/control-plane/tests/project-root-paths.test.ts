import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { ControlPlane } from '../src/control-plane';

/**
 * Project folders live on the user's computer. The server used to resolve
 * them against its own working directory, so "jhjj" became a path on the
 * hosted server, the session was recorded, and the gateway then refused it —
 * a FAILED session with no visible reason.
 */
describe('project folder paths', () => {
  let cp: ControlPlane;
  let base: string;
  let headers: Record<string, string>;

  beforeEach(async () => {
    cp = new ControlPlane({ port: 0 });
    await cp.start();
    base = cp.getUrl();
    const res = await fetch(`${base}/api/v1/auth/register`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: 'roots@test.dev', password: 'Password123!' }),
    });
    const { accessToken } = (await res.json()) as { accessToken: string };
    headers = { 'Content-Type': 'application/json', Authorization: `Bearer ${accessToken}` };
  });

  afterEach(async () => {
    await cp.stop();
  });

  it('refuses a folder that is not a full path, with a hint', async () => {
    const project = await fetch(`${base}/api/v1/projects`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ name: 'jhjj', root: 'jhjj' }),
    });
    expect(project.status).toBe(400);
    expect(((await project.json()) as { code: string }).code).toBe('PROJECT_ROOT_NOT_ABSOLUTE');

    const session = await fetch(`${base}/api/v1/sessions`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ agentId: 'mock', projectRoot: 'jhjj' }),
    });
    expect(session.status).toBe(400);
  });

  it('keeps a Windows path exactly as the workstation will see it', async () => {
    const res = await fetch(`${base}/api/v1/projects`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ root: 'C:\\projects\\shop\\' }),
    });
    const project = (await res.json()) as { root: string; name: string };
    expect(project.root).toBe('C:\\projects\\shop');
    expect(project.name).toBe('shop');
  });
});
