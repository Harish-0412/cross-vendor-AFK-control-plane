import { execFile } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { afterEach, describe, expect, it } from 'vitest';
import { commit, createBranch, getStatus, push } from '../src/git/git-operations';

const exec = promisify(execFile);
const roots: string[] = [];

async function repository(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'freebuff-phase9-'));
  roots.push(root);
  await exec('git', ['init', '-b', 'main'], { cwd: root });
  await exec('git', ['config', 'user.email', 'phase9@example.test'], { cwd: root });
  await exec('git', ['config', 'user.name', 'Phase 9'], { cwd: root });
  await writeFile(join(root, 'tracked.txt'), 'one\n');
  await exec('git', ['add', '--', 'tracked.txt'], { cwd: root });
  await exec('git', ['commit', '-m', 'initial'], { cwd: root });
  return root;
}

afterEach(async () => Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))));

describe('Phase 9 safe Git operations', () => {
  it('creates branches, commits exact content, and returns structured status', async () => {
    const root = await repository();
    await createBranch(root, 'feature/review');
    await writeFile(join(root, 'tracked.txt'), 'two\n');
    const before = await getStatus(root);
    expect(before.unstaged).toContain('tracked.txt');
    const result = await commit(root, 'phase 9 commit');
    expect(result.hash).toMatch(/^[0-9a-f]{40,64}$/);
    expect(result.status.clean).toBe(true);
    expect(await readFile(join(root, 'tracked.txt'), 'utf8')).toBe('two\n');
  });

  it('passes hostile-looking branch and commit values as literal argv without shell execution', async () => {
    const root = await repository();
    const branch = 'feature;echo-PWNED';
    await createBranch(root, branch);
    await writeFile(join(root, 'tracked.txt'), 'safe\n');
    await commit(root, 'message; echo PWNED > pwned.txt');
    expect((await exec('git', ['branch', '--show-current'], { cwd: root })).stdout.trim()).toBe(branch);
    await expect(readFile(join(root, 'pwned.txt'), 'utf8')).rejects.toThrow();
  });

  it('pushes to a disposable local remote without invoking a shell', async () => {
    const root = await repository();
    const remote = await mkdtemp(join(tmpdir(), 'freebuff-phase9-remote-'));
    roots.push(remote);
    await exec('git', ['init', '--bare'], { cwd: remote });
    await exec('git', ['remote', 'add', 'origin', remote], { cwd: root });
    await createBranch(root, 'feature/push');
    await writeFile(join(root, 'tracked.txt'), 'pushed\n');
    const committed = await commit(root, 'push fixture');
    await push(root, 'feature/push');
    const remoteHash = (await exec('git', ['--git-dir', remote, 'rev-parse', 'refs/heads/feature/push'])).stdout.trim();
    expect(remoteHash).toBe(committed.hash);
  });
});
