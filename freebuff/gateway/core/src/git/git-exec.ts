import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

export interface GitExecResult {
  success: boolean;
  stdout: string;
  stderr: string;
  exitCode?: number;
}

/** Executes Git without a shell. Every caller-provided value remains one literal argv item. */
export async function safeGitExec(
  cwd: string,
  args: readonly string[],
  options: { timeoutMs?: number; maxBuffer?: number } = {},
): Promise<GitExecResult> {
  try {
    const result = await execFileAsync('git', [...args], {
      cwd,
      timeout: options.timeoutMs ?? 10_000,
      maxBuffer: options.maxBuffer ?? 10 * 1024 * 1024,
      windowsHide: true,
    });
    return { success: true, stdout: result.stdout, stderr: result.stderr };
  } catch (error) {
    const gitError = error as Error & { stdout?: string; stderr?: string; code?: number };
    return {
      success: false,
      stdout: gitError.stdout ?? '',
      stderr: gitError.stderr ?? gitError.message,
      ...(typeof gitError.code === 'number' ? { exitCode: gitError.code } : {}),
    };
  }
}

export async function requireGitExec(cwd: string, args: readonly string[]): Promise<GitExecResult> {
  const result = await safeGitExec(cwd, args);
  if (!result.success) throw new Error(result.stderr.trim() || `git ${args[0] ?? ''} failed`);
  return result;
}
