import type { ConnectedAccount, PullRequestInput, RepositorySummary, VcsProvider } from './types';

export class VcsClient {
  constructor(
    private readonly provider: VcsProvider,
    private readonly token: string,
    private readonly fetchImpl: typeof fetch = fetch,
  ) {}

  async getCurrentUser(): Promise<ConnectedAccount> {
    const raw = asRecord(await this.request('/user'));
    switch (this.provider) {
      case 'github':
        return account(raw['login'], raw['name'], raw['avatar_url']);
      case 'gitlab':
        return account(raw['username'], raw['name'], raw['avatar_url']);
      case 'bitbucket': {
        const links = asRecord(raw['links']);
        return account(
          raw['nickname'] ?? raw['username'] ?? raw['display_name'],
          raw['display_name'],
          asRecord(links['avatar'])['href'],
        );
      }
    }
  }

  async listRepositories(): Promise<RepositorySummary[]> {
    const raw = await this.request(this.repositoriesPath());
    const entries =
      this.provider === 'bitbucket' ? arrayValue(asRecord(raw)['values']) : arrayValue(raw);
    return entries
      .map((entry) => this.repositoryFrom(asRecord(entry)))
      .filter((entry): entry is RepositorySummary => entry !== null);
  }

  async getRepository(fullName: string): Promise<RepositorySummary> {
    const raw = asRecord(await this.request(this.repositoryPath(fullName)));
    const repository = this.repositoryFrom(raw);
    if (!repository) throw new Error('Provider did not return a usable repository record');
    return repository;
  }

  createPullRequest(input: PullRequestInput): Promise<unknown> {
    const request = this.pullRequestRequest(input);
    return this.request(request.path, { method: 'POST', body: JSON.stringify(request.body) });
  }

  private repositoriesPath(): string {
    switch (this.provider) {
      case 'github':
        return '/user/repos?sort=updated&per_page=100';
      case 'gitlab':
        return '/projects?membership=true&simple=true&order_by=last_activity_at&per_page=100';
      case 'bitbucket':
        return '/repositories?role=member&pagelen=100';
    }
  }

  private repositoryPath(fullName: string): string {
    const repository = validateRepository(fullName);
    switch (this.provider) {
      case 'github':
        return '/repos/' + repository.split('/').map(encodeURIComponent).join('/');
      case 'gitlab':
        return '/projects/' + encodeURIComponent(repository);
      case 'bitbucket': {
        const parts = repository.split('/');
        if (parts.length !== 2)
          throw new Error('Bitbucket repository must be workspace/repository');
        return (
          '/repositories/' + encodeURIComponent(parts[0]!) + '/' + encodeURIComponent(parts[1]!)
        );
      }
    }
  }

  private repositoryFrom(raw: Record<string, unknown>): RepositorySummary | null {
    if (this.provider === 'github') {
      if (typeof raw['full_name'] !== 'string' || typeof raw['html_url'] !== 'string') return null;
      return {
        provider: this.provider,
        fullName: raw['full_name'],
        name: typeof raw['name'] === 'string' ? raw['name'] : raw['full_name'],
        webUrl: raw['html_url'],
        ...(typeof raw['default_branch'] === 'string'
          ? { defaultBranch: raw['default_branch'] }
          : {}),
        ...(typeof raw['private'] === 'boolean' ? { private: raw['private'] } : {}),
      };
    }
    if (this.provider === 'gitlab') {
      if (typeof raw['path_with_namespace'] !== 'string' || typeof raw['web_url'] !== 'string') {
        return null;
      }
      return {
        provider: this.provider,
        fullName: raw['path_with_namespace'],
        name: typeof raw['name'] === 'string' ? raw['name'] : raw['path_with_namespace'],
        webUrl: raw['web_url'],
        ...(typeof raw['default_branch'] === 'string'
          ? { defaultBranch: raw['default_branch'] }
          : {}),
        ...(typeof raw['visibility'] === 'string'
          ? { private: raw['visibility'] === 'private' }
          : {}),
      };
    }
    const links = asRecord(raw['links']);
    const fullName = typeof raw['full_name'] === 'string' ? raw['full_name'] : undefined;
    const webUrl = asRecord(links['html'])['href'];
    if (!fullName || typeof webUrl !== 'string') return null;
    const mainbranch = asRecord(raw['mainbranch']);
    return {
      provider: this.provider,
      fullName,
      name: typeof raw['name'] === 'string' ? raw['name'] : fullName,
      webUrl,
      ...(typeof mainbranch['name'] === 'string' ? { defaultBranch: mainbranch['name'] } : {}),
      ...(typeof raw['is_private'] === 'boolean' ? { private: raw['is_private'] } : {}),
    };
  }

  private pullRequestRequest(input: PullRequestInput): {
    path: string;
    body: Record<string, unknown>;
  } {
    const repository = validateRepository(input.repository);
    switch (this.provider) {
      case 'github':
        return {
          path: '/repos/' + repository.split('/').map(encodeURIComponent).join('/') + '/pulls',
          body: { title: input.title, head: input.head, base: input.base, body: input.description },
        };
      case 'gitlab':
        return {
          path: '/projects/' + encodeURIComponent(repository) + '/merge_requests',
          body: {
            title: input.title,
            source_branch: input.head,
            target_branch: input.base,
            description: input.description,
          },
        };
      case 'bitbucket': {
        const parts = repository.split('/');
        const workspace = parts[0];
        const repo = parts[1];
        if (!workspace || !repo || parts.length !== 2) {
          throw new Error('Bitbucket repository must be workspace/repository');
        }
        return {
          path:
            '/repositories/' +
            encodeURIComponent(workspace) +
            '/' +
            encodeURIComponent(repo) +
            '/pullrequests',
          body: {
            title: input.title,
            description: input.description,
            source: { branch: { name: input.head } },
            destination: { branch: { name: input.base } },
          },
        };
      }
    }
  }

  private async request(path: string, init: RequestInit = {}): Promise<unknown> {
    const response = await this.fetchImpl(this.apiBase() + path, {
      ...init,
      headers: {
        Accept: 'application/json',
        Authorization: 'Bearer ' + this.token,
        ...(this.provider === 'github' ? { 'X-GitHub-Api-Version': '2022-11-28' } : {}),
        ...(init.body ? { 'Content-Type': 'application/json' } : {}),
        ...init.headers,
      },
    });
    if (!response.ok)
      throw new Error(this.provider + ' API request failed (' + response.status + ')');
    return response.status === 204 ? null : response.json();
  }

  private apiBase(): string {
    switch (this.provider) {
      case 'github':
        return 'https://api.github.com';
      case 'gitlab':
        return 'https://gitlab.com/api/v4';
      case 'bitbucket':
        return 'https://api.bitbucket.org/2.0';
    }
  }
}

function validateRepository(value: string): string {
  if (!/^[A-Za-z0-9._-]+(?:\/[A-Za-z0-9._-]+)+$/.test(value)) {
    throw new Error('Repository path is invalid');
  }
  return value;
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' ? (value as Record<string, unknown>) : {};
}

function arrayValue(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function account(username: unknown, displayName: unknown, avatarUrl: unknown): ConnectedAccount {
  if (typeof username !== 'string' || !username) {
    throw new Error('Provider did not return an account name');
  }
  return {
    username,
    ...(typeof displayName === 'string' && displayName ? { displayName } : {}),
    ...(typeof avatarUrl === 'string' && avatarUrl ? { avatarUrl } : {}),
  };
}
