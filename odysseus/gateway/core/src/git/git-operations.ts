import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

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

/** Commit diffs larger than this are cut; the trace then covers what fits. */
const MAX_COMMIT_DIFF_BYTES = 1024 * 1024;

export async function commit(
  root: string,
  message: string,
  files?: readonly string[],
): Promise<{ hash: string; status: GitStatus; diff: string; diffTruncated: boolean }> {
  if (!message.trim()) throw new Error('Commit message is required');
  if (files?.some((file) => file.startsWith('-'))) throw new Error('Invalid file path');
  await requireGitExec(root, files?.length ? ['add', '--', ...files] : ['add', '-A', '--']);
  await requireGitExec(root, ['commit', '-m', message, '--']);
  const hash = (await requireGitExec(root, ['rev-parse', 'HEAD'])).stdout.trim();
  // Exactly what went into the commit, so an Agent Trace record can say which
  // lines of it the agent wrote.
  const shown = await safeGitExec(root, [
    'show',
    '--format=',
    '--no-color',
    '--no-ext-diff',
    '--unified=0',
    hash,
  ]);
  const diff = shown.success ? shown.stdout : '';
  const diffTruncated = diff.length > MAX_COMMIT_DIFF_BYTES;
  return {
    hash,
    status: await getStatus(root),
    diff: diffTruncated ? diff.slice(0, MAX_COMMIT_DIFF_BYTES) : diff,
    diffTruncated,
  };
}

export const TRACE_NOTES_REF = 'refs/notes/agent-trace';
/** Where the remote's notes land while they are merged into ours. */
const REMOTE_TRACE_NOTES_REF = 'refs/notes/odysseus-remote-agent-trace';
const NETWORK_TIMEOUT_MS = 60_000;

/**
 * Attach an Agent Trace record to a commit as a git note under
 * refs/notes/agent-trace. Notes travel with the commit without adding files
 * to the tree; `push` sends them along with the branch.
 */
export async function addTraceNote(
  root: string,
  revision: string,
  record: unknown,
): Promise<{ ref: string; revision: string }> {
  if (!/^[0-9a-f]{7,64}$/i.test(revision)) throw new Error('Invalid revision');
  const directory = await mkdtemp(join(tmpdir(), 'odysseus-trace-'));
  const file = join(directory, 'record.json');
  try {
    // A file, not -m: a record can exceed the Windows command-line limit.
    await writeFile(file, `${JSON.stringify(record, null, 2)}\n`, 'utf8');
    await requireGitExec(root, ['notes', '--ref=agent-trace', 'add', '-f', '-F', file, revision]);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
  return { ref: TRACE_NOTES_REF, revision };
}

export interface TraceNotesPush {
  /** `none` when this repository has no Agent Trace notes yet. */
  state: 'pushed' | 'none' | 'failed';
  /** Set when the remote's notes were merged in before pushing. */
  merged?: boolean;
  error?: string;
}

/**
 * Send refs/notes/agent-trace to the remote. When the remote has notes this
 * machine lacks (another machine pushed), they are merged in first; for a
 * commit both sides annotated, this machine's record wins. Never throws.
 */
export async function pushTraceNotes(root: string, remote = 'origin'): Promise<TraceNotesPush> {
  if (!remote || remote.startsWith('-')) throw new Error('Invalid remote name');
  const local = await safeGitExec(root, ['rev-parse', '--verify', '--quiet', TRACE_NOTES_REF]);
  if (!local.success) return { state: 'none' };

  const send = () =>
    safeGitExec(root, ['push', '--', remote, `${TRACE_NOTES_REF}:${TRACE_NOTES_REF}`], {
      timeoutMs: NETWORK_TIMEOUT_MS,
    });
  const first = await send();
  if (first.success) return { state: 'pushed' };

  // Rejected, most likely because the remote moved on: merge its notes and retry.
  const fetched = await safeGitExec(
    root,
    ['fetch', '--', remote, `+${TRACE_NOTES_REF}:${REMOTE_TRACE_NOTES_REF}`],
    { timeoutMs: NETWORK_TIMEOUT_MS },
  );
  if (!fetched.success) return { state: 'failed', error: gitError(first) };
  try {
    const merged = await safeGitExec(root, [
      'notes',
      '--ref=agent-trace',
      'merge',
      '--strategy=ours',
      '--quiet',
      REMOTE_TRACE_NOTES_REF,
    ]);
    if (!merged.success) return { state: 'failed', error: gitError(merged) };
    const second = await send();
    return second.success
      ? { state: 'pushed', merged: true }
      : { state: 'failed', error: gitError(second) };
  } finally {
    await safeGitExec(root, ['update-ref', '-d', REMOTE_TRACE_NOTES_REF]);
  }
}

function gitError(result: { stderr: string }): string {
  return result.stderr.trim().split('\n').slice(-1)[0] || 'git failed';
}

export async function push(
  root: string,
  branch: string,
  remote = 'origin',
  force = false,
): Promise<{ remote: string; branch: string; forced: boolean; traceNotes: TraceNotesPush }> {
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
  // Agent Trace notes go wherever the code goes. The branch is already
  // pushed, so a problem with the notes is reported, not thrown.
  return { remote, branch, forced: force, traceNotes: await pushTraceNotes(root, remote) };
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
