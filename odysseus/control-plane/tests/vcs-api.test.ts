import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { signJwt } from '../src/auth/jwt';
import { ControlPlane } from '../src/control-plane';

describe('version-control API and project binding', () => {
  let controlPlane: ControlPlane;
  let url: string;
  let token: string;
  let platformFetch: typeof fetch;

  beforeEach(async () => {
    platformFetch = globalThis.fetch;
    globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
      const requestUrl = String(input);
      if (requestUrl.startsWith('https://github.com/login/oauth/access_token')) {
        expect(String(init?.body)).toContain('code_verifier=');
        return json({ access_token: 'gho_never_returned_to_browser', scope: 'repo' });
      }
      if (requestUrl === 'https://api.github.com/user') {
        return json({ login: 'octavia', name: 'Octavia' });
      }
      if (requestUrl.includes('https://api.github.com/user/repos')) {
        return json([
          {
            full_name: 'acme/platform',
            name: 'platform',
            html_url: 'https://github.com/acme/platform',
            default_branch: 'main',
            private: true,
          },
        ]);
      }
      if (requestUrl === 'https://api.github.com/repos/acme/platform') {
        return json({
          full_name: 'acme/platform',
          name: 'platform',
          html_url: 'https://github.com/acme/platform',
          default_branch: 'main',
          private: true,
        });
      }
      return platformFetch(input, init);
    }) as typeof fetch;

    controlPlane = new ControlPlane({
      port: 0,
      jwtSecret: 'vcs-api-test-jwt-secret',
      credentialEncryptionSecret: 'vcs-api-test-encryption-secret',
      corsOrigins: ['https://app.example.test'],
      frontendUrl: 'https://app.example.test',
      githubClientId: 'github-client-id',
      githubClientSecret: 'github-client-secret',
      githubCallbackUrl: 'https://control.example.test/api/v1/integrations/github/oauth/callback',
    });
    url = (await controlPlane.start()).url;
    await controlPlane.db.users.create({
      id: 'usr_vcs_api',
      email: 'vcs@example.test',
      name: 'VCS user',
      role: 'owner',
    });
    await controlPlane.db.projects.create({
      id: 'proj_vcs_api',
      userId: 'usr_vcs_api',
      name: 'Platform',
      root: 'C:\\projects\\platform',
      preferences: { protectedBranches: ['main'] },
    });
    token = signJwt(
      { sub: 'usr_vcs_api', email: 'vcs@example.test', role: 'owner' },
      controlPlane.config.jwtSecret,
      3600,
    );
  });

  afterEach(async () => {
    globalThis.fetch = platformFetch;
    await controlPlane.stop();
  });

  it('keeps tokens out of the API, verifies the provider account, then verifies repository access before linking', async () => {
    const headers = { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json' };
    const before = await fetch(url + '/api/v1/integrations', { headers });
    expect(before.status).toBe(200);
    expect(await before.json()).toEqual({
      integrations: [
        expect.objectContaining({ provider: 'github', configured: true, connected: false }),
        expect.objectContaining({ provider: 'gitlab', configured: false, connected: false }),
        expect.objectContaining({ provider: 'bitbucket', configured: false, connected: false }),
      ],
    });

    const start = await fetch(url + '/api/v1/integrations/github/oauth/start', { headers });
    const started = (await start.json()) as { authorizationUrl: string };
    const authorizationUrl = new URL(started.authorizationUrl);
    expect(authorizationUrl.searchParams.get('state')).toBeTruthy();
    expect(authorizationUrl.searchParams.get('code_challenge_method')).toBe('S256');
    expect(started.authorizationUrl).not.toContain('github-client-secret');

    const callback = await fetch(
      url +
        '/api/v1/integrations/github/oauth/callback?state=' +
        encodeURIComponent(authorizationUrl.searchParams.get('state')!) +
        '&code=one-time-code',
      { redirect: 'manual' },
    );
    expect(callback.status).toBe(302);
    expect(callback.headers.get('location')).toBe(
      'https://app.example.test/integrations?provider=github&connection=connected',
    );

    const connected = await fetch(url + '/api/v1/integrations', { headers });
    const connectedBody = await connected.text();
    expect(connectedBody).toContain('octavia');
    expect(connectedBody).not.toContain('gho_never_returned_to_browser');

    const repositories = await fetch(url + '/api/v1/integrations/github/repositories', { headers });
    expect(await repositories.json()).toEqual({
      repositories: [expect.objectContaining({ fullName: 'acme/platform', defaultBranch: 'main' })],
    });

    const linked = await fetch(url + '/api/v1/projects/proj_vcs_api/preferences', {
      method: 'PATCH',
      headers,
      body: JSON.stringify({
        repository: {
          provider: 'github',
          fullName: 'acme/platform',
          webUrl: 'https://not-trusted.example.test/acme/platform',
        },
      }),
    });
    expect(linked.status).toBe(200);
    expect(await linked.json()).toMatchObject({
      preferences: {
        repository: {
          provider: 'github',
          fullName: 'acme/platform',
          defaultBranch: 'main',
          webUrl: 'https://github.com/acme/platform',
        },
      },
    });

    const disconnected = await fetch(url + '/api/v1/integrations/github', {
      method: 'DELETE',
      headers,
    });
    expect(disconnected.status).toBe(200);
    const after = await fetch(url + '/api/v1/integrations', { headers });
    expect(await after.json()).toMatchObject({
      integrations: expect.arrayContaining([
        expect.objectContaining({ provider: 'github', connected: false }),
      ]),
    });
  });
});

function json(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });
}
