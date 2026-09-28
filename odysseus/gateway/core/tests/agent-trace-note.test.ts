import { execFile } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';

import { buildAgentTrace } from '@odysseus/protocol';
import { afterEach, describe, expect, it } from 'vitest';

import { addTraceNote, commit } from '../src/git/git-operations';

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
    expect(JSON.parse(again.stdout).id).toBe('y');
  });

  it('refuses a revision that is not a commit id', async () => {
    const root = await repository();
    await expect(addTraceNote(root, '--help', {})).rejects.toThrow('Invalid revision');
  });
});
