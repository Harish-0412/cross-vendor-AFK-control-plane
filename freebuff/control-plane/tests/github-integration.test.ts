import { describe, expect, it, vi } from 'vitest';
import { MemoryDatabase } from '../src/db/memory-store';
import { GitHubOAuth } from '../src/integrations/github/oauth';
import { EncryptedTokenStore } from '../src/integrations/github/token-store';
import { GitHubClient } from '../src/integrations/github/github-client';

describe('Phase 9 GitHub integration security', () => {
  it('requests exactly repo scope and exchanges without exposing credentials in errors', async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ error: 'bad_verification_code', access_token: 'must-not-leak' }), { status: 401, headers: { 'content-type': 'application/json' } }));
    const oauth = new GitHubOAuth('client', 'client-secret', 'https://app.test/callback', 'state-secret', fetchMock as typeof fetch);
    const url = new URL(oauth.authorizationUrl('usr_1'));
    expect(url.searchParams.get('scope')).toBe('repo');
    await expect(oauth.exchangeCode('bad')).rejects.not.toThrow(/secret|must-not-leak/);
  });

  it('persists only AES-GCM ciphertext and decrypts for the owning user', async () => {
    const db = new MemoryDatabase();
    const store = new EncryptedTokenStore(db, 'test encryption key');
    await store.set('usr_1', 'gho_plaintext_token');
    const record = await db.integrationCredentials.find('usr_1', 'github');
    expect(JSON.stringify(record)).not.toContain('gho_plaintext_token');
    expect(await store.get('usr_1')).toBe('gho_plaintext_token');
    await expect(store.get('usr_2')).resolves.toBeNull();
    expect(JSON.stringify(await db.events.listBySession('any'))).not.toContain('gho_plaintext_token');
    expect(JSON.stringify(await db.audit.list())).not.toContain('gho_plaintext_token');
  });

  it('uses the REST contract for repository, branch, commit/push, and PR operations', async () => {
    const calls: Array<{ url: string; init?: RequestInit }> = [];
    const fetchMock = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      calls.push({ url, init });
      const value = url.includes('/git/ref/heads/') ? { object: { sha: 'parent' } }
        : url.includes('/git/commits/parent') ? { tree: { sha: 'base-tree' } }
          : url.endsWith('/git/blobs') ? { sha: 'blob' }
            : url.endsWith('/git/trees') ? { sha: 'tree' }
              : url.endsWith('/git/commits') ? { sha: 'commit' }
                : { ok: true };
      return new Response(JSON.stringify(value), { status: 200, headers: { 'content-type': 'application/json' } });
    });
    const client = new GitHubClient('gho_secret', fetchMock as typeof fetch);
    await client.listRepositories();
    await client.createBranch('owner', 'repo', 'feature', 'parent');
    await client.commitFiles('owner', 'repo', 'feature', 'message', [{ path: 'a.ts', content: 'value' }]);
    await client.createPullRequest('owner', 'repo', 'Review', 'feature', 'main');
    expect(calls.some((call) => call.url.endsWith('/user/repos?sort=updated&per_page=100'))).toBe(true);
    expect(calls.some((call) => call.url.endsWith('/git/refs') && call.init?.method === 'POST')).toBe(true);
    expect(calls.some((call) => call.url.endsWith('/git/refs/heads/feature') && call.init?.method === 'PATCH')).toBe(true);
    expect(calls.some((call) => call.url.endsWith('/pulls') && call.init?.method === 'POST')).toBe(true);
  });
});
