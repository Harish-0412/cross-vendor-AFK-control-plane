import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

/** The same non-shell, bounded git invocation pattern used by Gateway ProjectManager. */
export async function safeGitDiff(projectRoot: string): Promise<string> {
  try {
    const { stdout } = await execFileAsync('git', ['diff', '--no-ext-diff', '--binary', '--'], {
      cwd: projectRoot, timeout: 5_000, windowsHide: true, maxBuffer: 10 * 1024 * 1024,
    });
    return stdout;
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new Error(`Unable to collect git diff for ${projectRoot}: ${detail}`);
  }
}
