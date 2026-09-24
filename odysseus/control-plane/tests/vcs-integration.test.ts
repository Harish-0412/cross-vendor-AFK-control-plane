import { describe, expect, it, vi } from 'vitest';

import { MemoryDatabase } from '../src/db/memory-store';
import { VcsOAuth } from '../src/integrations/vcs/oauth';
import { VcsCredentialStore } from '../src/integrations/vcs/token-store';
import type { VcsProvider } from '../src/integrations/vcs/types';
import { VcsClient } from '../src/integrations/vcs/vcs-client';

const configurations = {
  github: {
    clientId: 'github-client',
    clientSecret: 'github-secret',
    callbackUrl: 'https://control.example.test/api/v1/integrations/github/oauth/callback',
  },
  gitlab: {
    clientId: 'gitlab-client',
    clientSecret: 'gitlab-secret',
    callbackUrl: 'https://control.example.test/api/v1/integrations/gitlab/oauth/callback',
  },
  bitbucket: {
    clientId: 'bitbucket-client',
    clientSecret: 'bitbucket-secret',
    callbackUrl: 'https://control.example.test/api/v1/integrations/bitbucket/oauth/callback',
  },
} as const;

describe('version-control connections', () => {
  it.each([
    ['github', 'repo', true],
    ['gitlab', 'api', true],
    ['bitbucket', 'repository account', false],
  ] as const)(
    'uses a provider-bound, opaque state and least required scopes for %s',
    async (provider, scope, usesPkce) => {
      const oauth = new VcsOAuth(configurations, vi.fn() as typeof fetch);
      const { authorizationUrl } = oauth.authorizationUrl(provider, 'usr_1');
      const url = new URL(authorizationUrl);

      expect(url.searchParams.get('scope')).toBe(scope);
      expect(url.searchParams.get('state')).toMatch(/^[A-Za-z0-9_-]{40,}$/);
      expect(url.searchParams.get('state')).not.toContain('usr_1');
      expect(url.searchParams.has('code_challenge')).toBe(usesPkce);
      expect(url.searchParams.get('code_challenge_method')).toBe(usesPkce ? 'S256' : null);
    },
  );

  it('exchanges a code with PKCE and refuses callback replay without leaking credentials', async () => {
    let tokenRequestBody = '';
    const fetchMock = vi.fn(async (_input: string | URL | Request, init?: RequestInit) => {
      tokenRequestBody = String(init?.body);
      return new Response(JSON.stringify({ access_token: 'gho_plaintext_token', scope: 'repo' }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    });
    const oauth = new VcsOAuth(configurations, fetchMock as typeof fetch);
    const { authorizationUrl } = oauth.authorizationUrl('github', 'usr_1');
    const state = new URL(authorizationUrl).searchParams.get('state')!;

    await expect(oauth.exchangeCode('github', state, 'valid-code')).resolves.toMatchObject({
      userId: 'usr_1',
      token: { scope: 'repo' },
    });
    expect(tokenRequestBody).toContain('code_verifier=');
    // The client secret is exchanged server-to-server; it is never placed in
    // the authorization URL or surfaced in an error returned to the browser.
    expect(new URL(authorizationUrl).toString()).not.toContain('github-secret');
    await expect(oauth.exchangeCode('github', state, 'replayed-code')).rejects.not.toThrow(
      /secret|gho_plaintext_token/,
    );
  });

  it('encrypts credentials with provider and user-bound authenticated data', async () => {
    const db = new MemoryDatabase();
    const store = new VcsCredentialStore(db, 'test encryption key');
    await store.set('usr_1', 'github', {
      accessToken: 'gho_plaintext_token',
      scope: 'repo',
      account: { username: 'octavia' },
      connectedAt: '2026-01-01T00:00:00.000Z',
    });
    const record = await db.integrationCredentials.find('usr_1', 'github');

    expect(JSON.stringify(record)).not.toContain('gho_plaintext_token');
    expect(await store.get('usr_1', 'github')).toMatchObject({
      accessToken: 'gho_plaintext_token',
      account: { username: 'octavia' },
    });
    expect(await store.get('usr_2', 'github')).toBeNull();

    await db.integrationCredentials.upsert({ ...record!, provider: 'gitlab' });
    expect(await store.get('usr_1', 'gitlab')).toBeNull();
  });

  it.each([
    [
      'github',
      { login: 'octavia', name: 'Octavia', avatar_url: 'https://avatars.example.test/o.png' },
      [
        {
          full_name: 'acme/platform',
          name: 'platform',
          html_url: 'https://github.com/acme/platform',
          default_branch: 'main',
          private: true,
        },
      ],
      '/repos/acme/platform/pulls',
      { title: 'Review', head: 'agent/change', base: 'main', body: 'Automated change' },
    ],
    [
      'gitlab',
      { username: 'octavia', name: 'Octavia', avatar_url: 'https://gitlab.example.test/o.png' },
      [
        {
          path_with_namespace: 'acme/platform',
          name: 'platform',
          web_url: 'https://gitlab.com/acme/platform',
          default_branch: 'main',
          visibility: 'private',
        },
      ],
      '/projects/acme%2Fplatform/merge_requests',
      {
        title: 'Review',
        source_branch: 'agent/change',
        target_branch: 'main',
        description: 'Automated change',
      },
    ],
    [
      'bitbucket',
      {
        nickname: 'octavia',
        display_name: 'Octavia',
        links: { avatar: { href: 'https://bitbucket.example.test/o.png' } },
      },
      {
        values: [
          {
            full_name: 'acme/platform',
            name: 'platform',
            links: { html: { href: 'https://bitbucket.org/acme/platform' } },
            mainbranch: { name: 'main' },
            is_private: true,
          },
        ],
      },
      '/repositories/acme/platform/pullrequests',
      {
        title: 'Review',
        description: 'Automated change',
        source: { branch: { name: 'agent/change' } },
        destination: { branch: { name: 'main' } },
      },
    ],
  ] as const)(
    'maps %s account, repository, and pull-request contracts independently',
    async (provider, profile, repositories, expectedPullRequestPath, expectedBody) => {
      const calls: Array<{ url: string; init?: RequestInit }> = [];
      const fetchMock = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
        const url = String(input);
        calls.push({ url, init });
        const payload = url.endsWith('/user')
          ? profile
          : url.includes('/pull') || url.includes('/merge_requests')
            ? { id: 1 }
            : repositories;
        return new Response(JSON.stringify(payload), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      });
      const client = new VcsClient(
        provider as VcsProvider,
        'provider-token',
        fetchMock as typeof fetch,
      );

      await expect(client.getCurrentUser()).resolves.toMatchObject({ username: 'octavia' });
      await expect(client.listRepositories()).resolves.toMatchObject([
        { fullName: 'acme/platform', defaultBranch: 'main' },
      ]);
      await client.createPullRequest({
        repository: 'acme/platform',
        title: 'Review',
        head: 'agent/change',
        base: 'main',
        description: 'Automated change',
      });

      const pullRequest = calls.find((call) => call.url.endsWith(expectedPullRequestPath));
      expect(pullRequest?.init?.method).toBe('POST');
      expect(JSON.parse(String(pullRequest?.init?.body))).toEqual(expectedBody);
      expect(pullRequest?.init?.headers).toMatchObject({ Authorization: 'Bearer provider-token' });
    },
  );
});
