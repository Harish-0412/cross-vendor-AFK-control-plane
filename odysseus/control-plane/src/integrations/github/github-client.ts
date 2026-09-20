export class GitHubClient {
  constructor(
    private readonly token: string,
    private readonly fetchImpl: typeof fetch = fetch,
  ) {}

  listRepositories(): Promise<unknown> {
    return this.request('/user/repos?sort=updated&per_page=100');
  }
  getRepository(owner: string, repo: string): Promise<unknown> {
    return this.request(`/repos/${part(owner)}/${part(repo)}`);
  }
  getBranch(owner: string, repo: string, branch: string): Promise<unknown> {
    return this.request(`/repos/${part(owner)}/${part(repo)}/branches/${part(branch)}`);
  }
  createBranch(owner: string, repo: string, branch: string, sha: string): Promise<unknown> {
    return this.request(`/repos/${part(owner)}/${part(repo)}/git/refs`, {
      method: 'POST',
      body: JSON.stringify({ ref: `refs/heads/${branch}`, sha }),
    });
  }
  createPullRequest(
    owner: string,
    repo: string,
    title: string,
    head: string,
    base: string,
    body?: string,
  ): Promise<unknown> {
    return this.request(`/repos/${part(owner)}/${part(repo)}/pulls`, {
      method: 'POST',
      body: JSON.stringify({ title, head, base, body }),
    });
  }
  async commitFiles(
    owner: string,
    repo: string,
    branch: string,
    message: string,
    files: Array<{ path: string; content: string }>,
  ): Promise<unknown> {
    const ref = (await this.request(
      `/repos/${part(owner)}/${part(repo)}/git/ref/heads/${part(branch)}`,
    )) as { object?: { sha?: string } };
    const parent = ref.object?.sha;
    if (!parent) throw new Error('GitHub branch did not return a commit SHA');
    const parentCommit = (await this.request(
      `/repos/${part(owner)}/${part(repo)}/git/commits/${part(parent)}`,
    )) as { tree?: { sha?: string } };
    const treeItems = await Promise.all(
      files.map(async (file) => {
        const blob = (await this.request(`/repos/${part(owner)}/${part(repo)}/git/blobs`, {
          method: 'POST',
          body: JSON.stringify({ content: file.content, encoding: 'utf-8' }),
        })) as { sha?: string };
        return { path: file.path, mode: '100644', type: 'blob', sha: blob.sha };
      }),
    );
    const tree = (await this.request(`/repos/${part(owner)}/${part(repo)}/git/trees`, {
      method: 'POST',
      body: JSON.stringify({ base_tree: parentCommit.tree?.sha, tree: treeItems }),
    })) as { sha?: string };
    const commit = (await this.request(`/repos/${part(owner)}/${part(repo)}/git/commits`, {
      method: 'POST',
      body: JSON.stringify({ message, tree: tree.sha, parents: [parent] }),
    })) as { sha?: string };
    await this.request(`/repos/${part(owner)}/${part(repo)}/git/refs/heads/${part(branch)}`, {
      method: 'PATCH',
      body: JSON.stringify({ sha: commit.sha, force: false }),
    });
    return commit;
  }

  private async request(path: string, init: RequestInit = {}): Promise<unknown> {
    const response = await this.fetchImpl(`https://api.github.com${path}`, {
      ...init,
      headers: {
        Accept: 'application/vnd.github+json',
        Authorization: `Bearer ${this.token}`,
        'X-GitHub-Api-Version': '2022-11-28',
        ...init.headers,
      },
    });
    if (!response.ok) throw new Error(`GitHub API request failed (${response.status})`);
    return response.status === 204 ? null : response.json();
  }
}

function part(value: string): string {
  if (!value || value.includes('/')) throw new Error('Invalid GitHub path component');
  return encodeURIComponent(value);
}
