import { requireGitExec, safeGitExec } from './git-exec';

export interface GitStatus {
  branch: string | null;
  ahead: number;
  behind: number;
  staged: string[];
  unstaged: string[];
  untracked: string[];
  clean: boolean;
}

async function validateBranch(root: string, branch: string): Promise<void> {
  if (!branch || branch.startsWith('-')) throw new Error('Invalid branch name');
  await requireGitExec(root, ['check-ref-format', '--branch', branch]);
}

export async function createBranch(
  root: string,
  branch: string,
  fromRef = 'HEAD',
): Promise<GitStatus> {
  await validateBranch(root, branch);
  if (fromRef.startsWith('-')) throw new Error('Invalid start ref');
  await requireGitExec(root, ['branch', '--', branch, fromRef]);
  await requireGitExec(root, ['switch', '--', branch]);
  return getStatus(root);
}

export async function commit(
  root: string,
  message: string,
  files?: readonly string[],
): Promise<{ hash: string; status: GitStatus }> {
  if (!message.trim()) throw new Error('Commit message is required');
  if (files?.some((file) => file.startsWith('-'))) throw new Error('Invalid file path');
  await requireGitExec(root, files?.length ? ['add', '--', ...files] : ['add', '-A', '--']);
  await requireGitExec(root, ['commit', '-m', message, '--']);
  const hash = (await requireGitExec(root, ['rev-parse', 'HEAD'])).stdout.trim();
  return { hash, status: await getStatus(root) };
}

export async function push(
  root: string,
  branch: string,
  remote = 'origin',
  force = false,
): Promise<{ remote: string; branch: string; forced: boolean }> {
  await validateBranch(root, branch);
  if (!remote || remote.startsWith('-')) throw new Error('Invalid remote name');
  const refspec = `refs/heads/${branch}:refs/heads/${branch}`;
  await requireGitExec(root, [
    'push',
    ...(force ? ['--force-with-lease'] : []),
    '--',
    remote,
    refspec,
  ]);
  return { remote, branch, forced: force };
}

export async function getStatus(root: string): Promise<GitStatus> {
  const result = await requireGitExec(root, ['status', '--porcelain=v2', '--branch', '-z']);
  const entries = result.stdout.split('\0').filter(Boolean);
  let branch: string | null = null;
  let ahead = 0;
  let behind = 0;
  const staged: string[] = [];
  const unstaged: string[] = [];
  const untracked: string[] = [];
  for (const entry of entries) {
    if (entry.startsWith('# branch.head '))
      branch = entry.slice(14) === '(detached)' ? null : entry.slice(14);
    else if (entry.startsWith('# branch.ab ')) {
      const match = /\+(\d+) -(\d+)/.exec(entry);
      if (match) {
        ahead = Number(match[1]);
        behind = Number(match[2]);
      }
    } else if (entry.startsWith('? ')) untracked.push(entry.slice(2));
    else if (entry.startsWith('1 ') || entry.startsWith('2 ')) {
      const parts = entry.split(' ');
      const xy = parts[1] ?? '..';
      const file = parts.slice(entry.startsWith('2 ') ? 9 : 8).join(' ');
      if (xy[0] !== '.') staged.push(file);
      if (xy[1] !== '.') unstaged.push(file);
    }
  }
  return {
    branch,
    ahead,
    behind,
    staged,
    unstaged,
    untracked,
    clean: !staged.length && !unstaged.length && !untracked.length,
  };
}

export async function collectDiff(root: string): Promise<string> {
  const result = await safeGitExec(root, ['diff', '--no-ext-diff', '--binary', '--']);
  if (!result.success) throw new Error(result.stderr);
  return result.stdout;
}
