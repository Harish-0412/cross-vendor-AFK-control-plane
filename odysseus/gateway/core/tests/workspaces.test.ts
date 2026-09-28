import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
  commitWorkspaceBranch,
  evaluateWorkspace,
  listRecentChanges,
  ownedWorkspace,
  prepareWorkspace,
  removeWorkspace,
  servedRoot,
  summariseTestOutput,
} from '../src/git/workspaces';

const git = (cwd: string, ...args: string[]) =>
  execFileSync('git', args, { cwd, encoding: 'utf8', windowsHide: true }).trim();

describe('isolated workspaces', () => {
  let sandbox: string;
  let repo: string;
  const savedHome = { HOME: process.env['HOME'], USERPROFILE: process.env['USERPROFILE'] };

  beforeAll(() => {
    sandbox = mkdtempSync(join(tmpdir(), 'odysseus-ws-'));
    // Workspaces live under the home folder; point it at the sandbox.
    process.env['HOME'] = sandbox;
    process.env['USERPROFILE'] = sandbox;
    repo = join(sandbox, 'repo');
    mkdirSync(join(repo, 'node_modules', 'dep'), { recursive: true });
    writeFileSync(join(repo, 'node_modules', 'dep', 'index.js'), 'module.exports = 1;\n');
    writeFileSync(join(repo, '.gitignore'), 'node_modules\n');
    writeFileSync(
      join(repo, 'package.json'),
      JSON.stringify({ name: 'demo', scripts: { test: 'node check.js' } }),
    );
    writeFileSync(join(repo, 'check.js'), "require('./node_modules/dep');\nprocess.exit(0);\n");
    writeFileSync(join(repo, 'app.js'), 'module.exports = 1;\n');
    git(repo, 'init', '-q', '-b', 'main');
    git(repo, 'config', 'user.email', 't@example.com');
    git(repo, 'config', 'user.name', 'Test');
    git(repo, 'add', '-A');
    git(repo, 'commit', '-q', '-m', 'first');
    writeFileSync(join(repo, 'app.js'), 'module.exports = 2;\n');
    mkdirSync(join(repo, 'tests'));
    writeFileSync(join(repo, 'tests', 'app.test.js'), '// test\n');
    git(repo, 'add', '-A');
    git(repo, 'commit', '-q', '-m', 'Make app return two');
  });

  afterAll(() => {
    process.env['HOME'] = savedHome.HOME;
    process.env['USERPROFILE'] = savedHome.USERPROFILE;
    rmSync(sandbox, { recursive: true, force: true });
  });

  it('only serves project roots inside the gateway folders', () => {
    expect(servedRoot(repo, [sandbox])).toBe(repo);
    expect(() => servedRoot(repo, [join(sandbox, 'elsewhere')])).toThrow(/not inside/);
    expect(() => servedRoot('repo', [sandbox])).toThrow(/full path/);
    expect(() => ownedWorkspace(repo)).toThrow(/Not an Odysseus workspace/);
  });

  it('isolates a change, runs the tests, becomes a branch, and cleans up', async () => {
    const workspace = await prepareWorkspace(repo, 'HEAD', 'claude-code');
    expect(existsSync(join(workspace.workspaceRoot, 'node_modules', 'dep', 'index.js'))).toBe(true);

    writeFileSync(join(workspace.workspaceRoot, 'app.js'), 'module.exports = 3;\n');
    writeFileSync(join(workspace.workspaceRoot, 'new.js'), 'export {};\n');
    const evaluation = await evaluateWorkspace(workspace.workspaceRoot, workspace.commit);

    expect(evaluation.files.map((file) => file.path).sort()).toEqual(['app.js', 'new.js']);
    expect(evaluation.tests.ran).toBe(true);
    expect(evaluation.tests.passed).toBe(true);
    // The user's own folder is untouched.
    expect(git(repo, 'status', '--porcelain')).toBe('');

    const branch = await commitWorkspaceBranch(
      workspace.workspaceRoot,
      'odysseus/test-result',
      'Result',
    );
    expect(git(repo, 'branch', '--list', 'odysseus/test-result')).toContain('odysseus/test-result');
    expect(branch.commit).toMatch(/^[0-9a-f]{40}$/);

    await removeWorkspace(workspace.workspaceRoot);
    expect(existsSync(workspace.workspaceRoot)).toBe(false);
    // The linked dependencies were unlinked, never deleted through the link.
    expect(existsSync(join(repo, 'node_modules', 'dep', 'index.js'))).toBe(true);
  });

  it('lists recent changes with their parent commit and test files', async () => {
    const changes = await listRecentChanges(repo, 5);
    expect(changes[0]).toMatchObject({ title: 'Make app return two', testFiles: ['tests/app.test.js'] });
    expect(changes[0]!.parent).toBe(git(repo, 'rev-parse', 'HEAD~1'));
  });

  it('reads the summary line of common test runners', () => {
    expect(summariseTestOutput(' Tests  3 failed | 10 passed (13)\n')).toBe('3 failed | 10 passed (13)');
    expect(summariseTestOutput('===== 5 passed, 1 failed in 0.42s =====')).toBe('5 passed, 1 failed');
  });
});
