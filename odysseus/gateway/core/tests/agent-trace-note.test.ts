import { execFile } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';

import { buildAgentTrace } from '@odysseus/protocol';
import { afterEach, describe, expect, it } from 'vitest';

import {
  addTraceNote,
  commit,
  createBranch,
  push,
  pushTraceNotes,
} from '../src/git/git-operations';

const exec = promisify(execFile);
const roots: string[] = [];

async function repository(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'odysseus-trace-'));
  roots.push(root);
  await exec('git', ['init', '-b', 'main'], { cwd: root });
  await exec('git', ['config', 'user.email', 'trace@example.test'], { cwd: root });
  await exec('git', ['config', 'user.name', 'Trace'], { cwd: root });
  await writeFile(join(root, 'app.ts'), 'const a = 1;\nexport default a;\n');
  await exec('git', ['add', '--', 'app.ts'], { cwd: root });
  await exec('git', ['commit', '-m', 'initial'], { cwd: root });
  return root;
}

afterEach(async () =>
  Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))),
);

describe('Agent Trace notes on commits', () => {
  it('returns exactly what was committed, as a diff a trace can attribute', async () => {
    const root = await repository();
    await writeFile(join(root, 'app.ts'), 'const a = 1;\nconst b = 2;\nexport default a;\n');
    await writeFile(join(root, 'new.ts'), 'export const n = 1;\n');
    const result = await commit(root, 'agent work');

    const record = buildAgentTrace({
      id: '550e8400-e29b-41d4-a716-446655440000',
      timestamp: '2026-09-28T10:00:00Z',
      diff: result.diff,
      contributor: { type: 'ai' },
      vcs: { type: 'git', revision: result.hash },
    });
    expect(result.diffTruncated).toBe(false);
    expect(
      record.files.map((file) => [
        file.path,
        file.conversations[0]!.ranges.map((range) => [range.start_line, range.end_line]),
      ]),
    ).toEqual([
      ['app.ts', [[2, 2]]],
      ['new.ts', [[1, 1]]],
    ]);
  });

  it('stores the record as a git note on the commit', async () => {
    const root = await repository();
    await writeFile(join(root, 'app.ts'), 'const a = 3;\nexport default a;\n');
    const { hash } = await commit(root, 'agent work');
    const record = { version: '0.1', id: 'x', timestamp: '2026-09-28T10:00:00Z', files: [] };

    expect(await addTraceNote(root, hash, record)).toEqual({
      ref: 'refs/notes/agent-trace',
      revision: hash,
    });
    const note = await exec('git', ['notes', '--ref=agent-trace', 'show', hash], { cwd: root });
    expect(JSON.parse(note.stdout)).toEqual(record);

    // Writing again replaces the note rather than failing.
    await addTraceNote(root, hash, { ...record, id: 'y' });
    const again = await exec('git', ['notes', '--ref=agent-trace', 'show', hash], { cwd: root });
    expect((JSON.parse(again.stdout) as { id: string }).id).toBe('y');
  });

  it('refuses a revision that is not a commit id', async () => {
    const root = await repository();
    await expect(addTraceNote(root, '--help', {})).rejects.toThrow('Invalid revision');
  });
});

describe('Agent Trace notes on the remote', () => {
  async function bareRemote(): Promise<string> {
    const remote = await mkdtemp(join(tmpdir(), 'odysseus-trace-remote-'));
    roots.push(remote);
    await exec('git', ['init', '--bare'], { cwd: remote });
    return remote;
  }

  async function remoteNote(remote: string, revision: string): Promise<unknown> {
    const note = await exec('git', [
      '--git-dir',
      remote,
      'notes',
      '--ref=agent-trace',
      'show',
      revision,
    ]);
    return JSON.parse(note.stdout) as unknown;
  }

  it('pushes the notes along with the branch', async () => {
    const root = await repository();
    const remote = await bareRemote();
    await exec('git', ['remote', 'add', 'origin', remote], { cwd: root });
    await writeFile(join(root, 'app.ts'), 'const a = 2;\nexport default a;\n');
    const { hash } = await commit(root, 'agent work');
    await addTraceNote(root, hash, { id: 'first' });

    const result = await push(root, 'main');

    expect(result.traceNotes).toEqual({ state: 'pushed' });
    expect(await remoteNote(remote, hash)).toEqual({ id: 'first' });
  });

  it("merges another machine's notes instead of losing them", async () => {
    const root = await repository();
    const remote = await bareRemote();
    await exec('git', ['remote', 'add', 'origin', remote], { cwd: root });
    await push(root, 'main');

    // A second machine annotates a commit of its own and pushes first.
    const other = await mkdtemp(join(tmpdir(), 'odysseus-trace-other-'));
    roots.push(other);
    await exec('git', ['clone', '-b', 'main', remote, other]);
    await exec('git', ['config', 'user.email', 'other@example.test'], { cwd: other });
    await exec('git', ['config', 'user.name', 'Other'], { cwd: other });
    await writeFile(join(other, 'other.ts'), 'export const o = 1;\n');
    const theirs = await commit(other, 'their work');
    await addTraceNote(other, theirs.hash, { id: 'theirs' });
    expect((await push(other, 'main')).traceNotes.state).toBe('pushed');

    // This machine annotates its own commit on a branch and pushes.
    await createBranch(root, 'feature/mine');
    await writeFile(join(root, 'app.ts'), 'const a = 5;\nexport default a;\n');
    const mine = await commit(root, 'my work');
    await addTraceNote(root, mine.hash, { id: 'mine' });
    const result = await push(root, 'feature/mine');

    expect(result.traceNotes).toEqual({ state: 'pushed', merged: true });
    expect(await remoteNote(remote, mine.hash)).toEqual({ id: 'mine' });
    expect(await remoteNote(remote, theirs.hash)).toEqual({ id: 'theirs' });
  });

  it('says there was nothing to push when no commit has a note', async () => {
    const root = await repository();
    const remote = await bareRemote();
    await exec('git', ['remote', 'add', 'origin', remote], { cwd: root });
    expect((await push(root, 'main')).traceNotes).toEqual({ state: 'none' });
    expect(await pushTraceNotes(root)).toEqual({ state: 'none' });
  });

  it('reports a notes failure without failing the branch push', async () => {
    const root = await repository();
    await addTraceNote(
      root,
      (await exec('git', ['rev-parse', 'HEAD'], { cwd: root })).stdout.trim(),
      {},
    );
    const result = await pushTraceNotes(root, 'nowhere');
    expect(result.state).toBe('failed');
    expect(result.error).toBeTruthy();
  });
});
