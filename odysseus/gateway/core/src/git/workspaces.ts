/**
 * Isolated workspaces: one git worktree per agent attempt.
 *
 * Contests and benchmarks run several agents on the same task at once. Each
 * gets its own checkout, so they cannot edit files under each other and none
 * of them touches the user's working folder. A worktree shares the repository,
 * so creating one is fast and a result can become a branch the user sees in
 * their own clone.
 *
 * Every path the Control Plane names is checked here: a project root must be
 * one this gateway serves, and a workspace must be one this module created.
 */
import { spawn } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { existsSync } from 'node:fs';
import { lstat, mkdir, readdir, readFile, rm, rmdir, symlink, unlink } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';

import { requireGitExec, safeGitExec } from './git-exec';

/** Where workspaces live. Outside every project, so no agent sees another's. */
export function workspacesRoot(): string {
  return join(homedir(), '.odysseus', 'worktrees');
}

const MAX_DIFF_BYTES = 400_000;
const OUTPUT_TAIL_CHARS = 6_000;
const TEST_TIMEOUT_MS = 12 * 60_000;
const DEPENDENCY_DIRS = ['node_modules', '.venv', 'venv'];

export interface PreparedWorkspace {
  workspaceRoot: string;
  commit: string;
}

export interface FileChange {
  path: string;
  added: number;
  removed: number;
}

export interface TestRun {
  ran: boolean;
  passed: boolean;
  command: string;
  exitCode: number | null;
  durationMs: number;
  /** "12 passed, 1 failed" when the runner's summary could be read. */
  summary: string;
  outputTail: string;
}

export interface WorkspaceEvaluation {
  diff: string;
  diffTruncated: boolean;
  files: FileChange[];
  added: number;
  removed: number;
  tests: TestRun;
}

export interface RecentChange {
  commit: string;
  parent: string;
  title: string;
  body: string;
  date: string;
  files: FileChange[];
  testFiles: string[];
}

// ------------------------------------------------------------------ guards

function isInside(child: string, root: string): boolean {
  const rel = relative(root, child);
  return rel === '' || (!!rel && !rel.startsWith('..') && !isAbsolute(rel));
}

/** The project root, provided it is one of the folders this gateway serves. */
export function servedRoot(requested: string, allowed: readonly string[]): string {
  if (!requested || !isAbsolute(requested)) throw new Error('projectRoot must be a full path');
  const root = resolve(requested);
  if (!allowed.some((candidate) => isInside(root, resolve(candidate)))) {
    throw new Error(`${root} is not inside a folder this gateway serves`);
  }
  return root;
}

/** A workspace this module created, never an arbitrary folder. */
export function ownedWorkspace(requested: string): string {
  if (!requested || !isAbsolute(requested)) throw new Error('workspaceRoot must be a full path');
  const root = resolve(requested);
  const base = workspacesRoot();
  if (!isInside(root, base) || root === base) throw new Error('Not an Odysseus workspace');
  return root;
}

function safeRef(ref: string): string {
  if (!ref || ref.startsWith('-') || /\s/.test(ref)) throw new Error('Invalid git ref');
  return ref;
}

// ----------------------------------------------------------------- prepare

/**
 * Check out `ref` into a new worktree and give it the project's installed
 * dependencies, so its tests can run without a fresh install.
 */
export async function prepareWorkspace(
  projectRoot: string,
  ref = 'HEAD',
  label = 'run',
): Promise<PreparedWorkspace> {
  const top = (await requireGitExec(projectRoot, ['rev-parse', '--show-toplevel'])).stdout.trim();
  const commit = (
    await requireGitExec(projectRoot, ['rev-parse', '--verify', `${safeRef(ref)}^{commit}`])
  ).stdout.trim();

  const project = createHash('sha256').update(resolve(top)).digest('hex').slice(0, 12);
  const slug = label.replace(/[^a-z0-9-]/gi, '-').slice(0, 40) || 'run';
  const workspaceRoot = join(
    workspacesRoot(),
    project,
    `${slug}-${randomBytes(4).toString('hex')}`,
  );
  await mkdir(dirname(workspaceRoot), { recursive: true });
  await requireGitExec(top, ['worktree', 'add', '--detach', '--', workspaceRoot, commit]);

  // The worktree mirrors the repository root; a project root below it keeps
  // its relative position.
  const offset = relative(resolve(top), resolve(projectRoot));
  const projectInWorkspace = offset ? join(workspaceRoot, offset) : workspaceRoot;
  await linkDependencies(resolve(top), workspaceRoot);
  return { workspaceRoot: projectInWorkspace, commit };
}

/** Link each installed dependency folder (up to three levels deep) into the worktree. */
async function linkDependencies(from: string, to: string): Promise<void> {
  const walk = async (dir: string, depth: number): Promise<void> => {
    if (depth > 3) return;
    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (!entry.isDirectory() || entry.name === '.git') continue;
      const source = join(dir, entry.name);
      const target = join(to, relative(from, source));
      if (DEPENDENCY_DIRS.includes(entry.name)) {
        if (existsSync(dirname(target)) && !existsSync(target)) {
          await symlink(source, target, process.platform === 'win32' ? 'junction' : 'dir').catch(
            () => undefined,
          );
        }
        continue;
      }
      if (entry.name.startsWith('.')) continue;
      await walk(source, depth + 1);
    }
  };
  await walk(from, 0);
}

// ---------------------------------------------------------------- evaluate

/**
 * What the agent changed, and whether the tests pass afterwards. With
 * `realTests`, the test files of a real change are checked out first — the
 * way a benchmark grades an attempt against the tests that shipped with it.
 */
export async function evaluateWorkspace(
  workspaceRoot: string,
  baseCommit: string,
  realTests?: { commit: string; paths: string[] },
): Promise<WorkspaceEvaluation> {
  const root = ownedWorkspace(workspaceRoot);
  // Intent-to-add makes new files visible to diff without staging content.
  await safeGitExec(root, ['add', '-A', '--intent-to-add', '--', '.']);
  const base = safeRef(baseCommit);
  const numstat = await safeGitExec(root, ['diff', '--numstat', base, '--'], {
    maxBuffer: 20 * 1024 * 1024,
  });
  const files = parseNumstat(numstat.stdout);
  const diffResult = await safeGitExec(root, ['diff', '--no-ext-diff', base, '--'], {
    maxBuffer: 50 * 1024 * 1024,
  });
  const fullDiff = diffResult.stdout;

  if (realTests && realTests.paths.length) {
    const paths = realTests.paths.filter((path) => !path.startsWith('-'));
    await safeGitExec(root, ['checkout', safeRef(realTests.commit), '--', ...paths]);
  }
  const tests = await runTests(root);

  return {
    diff: fullDiff.length > MAX_DIFF_BYTES ? fullDiff.slice(0, MAX_DIFF_BYTES) : fullDiff,
    diffTruncated: fullDiff.length > MAX_DIFF_BYTES,
    files,
    added: files.reduce((sum, file) => sum + file.added, 0),
    removed: files.reduce((sum, file) => sum + file.removed, 0),
    tests,
  };
}

function parseNumstat(text: string): FileChange[] {
  return text
    .split('\n')
    .map((line) => line.split('\t'))
    .filter((parts) => parts.length >= 3 && parts[2])
    .map(([added, removed, path]) => ({
      path: path!,
      added: Number(added) || 0,
      removed: Number(removed) || 0,
    }));
}

// ------------------------------------------------------------------- tests

interface TestCommand {
  label: string;
  command: string;
  args: string[];
}

/** The project's own test command, read from its files. Nothing is invented. */
export async function detectTestCommand(root: string): Promise<TestCommand | null> {
  const packageJson = join(root, 'package.json');
  if (existsSync(packageJson)) {
    try {
      const scripts = (
        JSON.parse(await readFile(packageJson, 'utf8')) as {
          scripts?: Record<string, string>;
        }
      ).scripts;
      const test = scripts?.['test'];
      if (test && !/no test specified/i.test(test)) {
        const manager = existsSync(join(root, 'pnpm-lock.yaml'))
          ? 'pnpm'
          : existsSync(join(root, 'yarn.lock'))
            ? 'yarn'
            : existsSync(join(root, 'bun.lockb'))
              ? 'bun'
              : 'npm';
        return { label: `${manager} test`, command: manager, args: ['test'] };
      }
    } catch {
      /* unreadable package.json: fall through */
    }
  }
  if (
    ['pytest.ini', 'pyproject.toml', 'setup.cfg', 'tox.ini'].some((f) => existsSync(join(root, f)))
  )
    return { label: 'pytest', command: 'python', args: ['-m', 'pytest', '-q'] };
  if (existsSync(join(root, 'Cargo.toml')))
    return { label: 'cargo test', command: 'cargo', args: ['test'] };
  if (existsSync(join(root, 'go.mod')))
    return { label: 'go test', command: 'go', args: ['test', './...'] };
  return null;
}

async function runTests(root: string): Promise<TestRun> {
  const detected = await detectTestCommand(root);
  if (!detected) {
    return {
      ran: false,
      passed: false,
      command: '',
      exitCode: null,
      durationMs: 0,
      summary: 'No test command found in this project',
      outputTail: '',
    };
  }
  const started = Date.now();
  const { code, output } = await runCommand(detected.command, detected.args, root);
  const durationMs = Date.now() - started;
  return {
    ran: true,
    passed: code === 0,
    command: detected.label,
    exitCode: code,
    durationMs,
    summary: summariseTestOutput(output) || (code === 0 ? 'Passed' : `Exited with code ${code}`),
    outputTail: output.slice(-OUTPUT_TAIL_CHARS),
  };
}

/**
 * Run a fixed command. On Windows package managers are .cmd shims, which
 * Node only starts through a shell; the command and arguments here are
 * constants chosen above, never text from the Control Plane.
 */
function runCommand(
  command: string,
  args: string[],
  cwd: string,
): Promise<{ code: number | null; output: string }> {
  return new Promise((resolvePromise) => {
    let output = '';
    const child = spawn(command, args, {
      cwd,
      shell: process.platform === 'win32',
      windowsHide: true,
      // CI makes Vitest and Jest run once instead of watching.
      env: { ...process.env, CI: 'true', FORCE_COLOR: '0' },
    });
    const append = (chunk: Buffer) => {
      output += chunk.toString('utf8');
      if (output.length > 200_000) output = output.slice(-100_000);
    };
    child.stdout?.on('data', append);
    child.stderr?.on('data', append);
    const timer = setTimeout(() => {
      output += `\n[stopped after ${Math.round(TEST_TIMEOUT_MS / 60_000)} minutes]`;
      child.kill('SIGKILL');
    }, TEST_TIMEOUT_MS);
    child.on('error', (error) => {
      clearTimeout(timer);
      resolvePromise({ code: null, output: `${output}\n${error.message}` });
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      resolvePromise({ code, output });
    });
  });
}

/** Terminal colour codes, which some runners print even with FORCE_COLOR=0. */
const ANSI_COLOUR = new RegExp(`${String.fromCharCode(27)}\\[[0-9;]*m`, 'g');

/** "12 passed, 1 failed" from the common runners' summaries. */
export function summariseTestOutput(output: string): string {
  const text = output.replace(ANSI_COLOUR, '');
  const vitest = [...text.matchAll(/Tests\s+(.+?\(\d+\))/g)].at(-1)?.[1];
  if (vitest) return vitest.replace(/\s+/g, ' ').trim();
  const jest = [...text.matchAll(/Tests:\s+(.+total)/g)].at(-1)?.[1];
  if (jest) return jest.trim();
  const pytest = [...text.matchAll(/=+ (.*(?:passed|failed|error).*?) in [\d.]+s/g)].at(-1)?.[1];
  if (pytest) return pytest.trim();
  const cargo = [...text.matchAll(/test result: (\w+)\. (\d+ passed; \d+ failed)/g)].at(-1);
  if (cargo) return `${cargo[2]}`;
  return '';
}

// ------------------------------------------------------------------ history

const TEST_FILE =
  /(^|\/)(tests?|__tests__|spec)\/|\.(test|spec)\.[cm]?[jt]sx?$|_test\.(go|py)$|(^|\/)test_[^/]+\.py$/i;

/**
 * The most recent changes merged into the current branch, each with the
 * commit it started from. Merge commits describe a pull request; on a
 * squash-merge history each commit is one.
 */
export async function listRecentChanges(projectRoot: string, limit = 10): Promise<RecentChange[]> {
  const count = Math.max(1, Math.min(50, Math.floor(limit)));
  const log = await requireGitExec(projectRoot, [
    'log',
    '--first-parent',
    '--no-color',
    `-n${count * 4}`,
    '--format=%H%x1f%P%x1f%cI%x1f%s%x1f%b%x1e',
    'HEAD',
  ]);
  const changes: RecentChange[] = [];
  for (const record of log.stdout.split('\x1e')) {
    if (changes.length >= count) break;
    const [commit, parents, date, subject, body] = record.replace(/^\s+/, '').split('\x1f');
    if (!commit || !parents) continue;
    const parent = parents.split(' ')[0]!;
    const numstat = await safeGitExec(projectRoot, ['diff', '--numstat', parent, commit, '--']);
    const files = parseNumstat(numstat.stdout);
    const code = files.filter((file) => !/\.(md|txt|lock|json)$/i.test(file.path));
    // Changes that are too small to judge or too large to be one task are skipped.
    if (code.length === 0 || files.length > 40) continue;
    const lines = files.reduce((sum, file) => sum + file.added + file.removed, 0);
    if (lines > 3_000) continue;
    const bodyText = (body ?? '').trim();
    const merge = /^Merge (pull request|branch)/i.test(subject ?? '');
    const title = merge && bodyText ? bodyText.split('\n')[0]!.trim() : (subject ?? '').trim();
    changes.push({
      commit,
      parent,
      title,
      body: merge ? bodyText.split('\n').slice(1).join('\n').trim() : bodyText,
      date: date ?? '',
      files,
      testFiles: files.map((file) => file.path).filter((path) => TEST_FILE.test(path)),
    });
  }
  return changes;
}

// ------------------------------------------------------------ apply & remove

/** Commit a workspace's changes to a new branch the user can review and merge. */
export async function commitWorkspaceBranch(
  workspaceRoot: string,
  branch: string,
  message: string,
): Promise<{ branch: string; commit: string }> {
  const root = ownedWorkspace(workspaceRoot);
  if (!/^[A-Za-z0-9._/-]+$/.test(branch) || branch.startsWith('-')) {
    throw new Error('Invalid branch name');
  }
  await requireGitExec(root, ['check-ref-format', '--branch', branch]);
  await requireGitExec(root, ['switch', '-c', branch]);
  await requireGitExec(root, ['add', '-A', '--', '.']);
  await requireGitExec(root, ['commit', '--no-verify', '-m', message || 'Odysseus result']);
  const commit = (await requireGitExec(root, ['rev-parse', 'HEAD'])).stdout.trim();
  return { branch, commit };
}

/**
 * Delete a workspace. The dependency links are removed first: deleting
 * through a junction would delete the project's real node_modules.
 */
export async function removeWorkspace(workspaceRoot: string): Promise<void> {
  const root = ownedWorkspace(workspaceRoot);
  const top = await safeGitExec(root, ['rev-parse', '--show-toplevel']);
  const worktree = top.success ? resolve(top.stdout.trim()) : root;
  await unlinkDependencies(worktree);
  const common = await safeGitExec(worktree, ['rev-parse', '--git-common-dir']);
  await safeGitExec(worktree, ['worktree', 'remove', '--force', worktree]);
  if (existsSync(worktree)) await rm(worktree, { recursive: true, force: true });
  if (common.success) {
    const repo = resolve(worktree, common.stdout.trim(), '..');
    await safeGitExec(repo, ['worktree', 'prune']);
  }
  // The per-project folder, once its last workspace is gone; rmdir refuses a non-empty one.
  const parent = dirname(worktree);
  if (parent !== workspacesRoot() && isInside(parent, workspacesRoot()))
    await rmdir(parent).catch(() => undefined);
}

async function unlinkDependencies(root: string): Promise<void> {
  const walk = async (dir: string, depth: number): Promise<void> => {
    if (depth > 4) return;
    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const path = join(dir, entry.name);
      const info = await lstat(path).catch(() => null);
      if (!info) continue;
      if (info.isSymbolicLink()) {
        // Either call removes only the link; neither follows it.
        if (DEPENDENCY_DIRS.includes(entry.name))
          await unlink(path).catch(() => rmdir(path).catch(() => undefined));
        continue;
      }
      if (info.isDirectory() && entry.name !== '.git') await walk(path, depth + 1);
    }
  };
  await walk(root, 0);
}
