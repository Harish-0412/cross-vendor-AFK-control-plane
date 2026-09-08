import { execFile } from 'node:child_process';
import { access } from 'node:fs/promises';
import { join } from 'node:path';
import { promisify } from 'node:util';

import type { GitTestResult } from '@freebuff/protocol';

const execFileAsync = promisify(execFile);

async function exists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

export async function runProjectTests(root: string): Promise<GitTestResult> {
  const manager = (await exists(join(root, 'pnpm-lock.yaml')))
    ? 'pnpm'
    : (await exists(join(root, 'yarn.lock')))
      ? 'yarn'
      : 'npm';
  const executable = process.platform === 'win32' ? `${manager}.cmd` : manager;
  const args = manager === 'yarn' ? ['test', '--runInBand'] : ['test', '--', '--run'];
  try {
    const result = await execFileAsync(executable, args, {
      cwd: root,
      windowsHide: true,
      timeout: 10 * 60_000,
      maxBuffer: 20 * 1024 * 1024,
    });
    return {
      command: [manager, ...args],
      passed: true,
      exitCode: 0,
      stdout: result.stdout,
      stderr: result.stderr,
    };
  } catch (error) {
    const processError = error as Error & { stdout?: string; stderr?: string; code?: number };
    return {
      command: [manager, ...args],
      passed: false,
      exitCode: typeof processError.code === 'number' ? processError.code : null,
      stdout: processError.stdout ?? '',
      stderr: processError.stderr ?? processError.message,
    };
  }
}
