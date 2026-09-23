import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
const execFileAsync = promisify(execFile);

export async function safeGitDiff(projectRoot: string): Promise<string> {
  try {
    const { stdout } = await execFileAsync(
      'git',
      ['diff', 'HEAD', '--no-ext-diff', '--binary', '--'],
      { cwd: projectRoot, timeout: 10_000, windowsHide: true, maxBuffer: 20 * 1024 * 1024 },
    );
    return stdout;
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    if (/not a git repository/i.test(detail))
      return `# ${projectRoot} is not a git repository; no diff available\n`;
    throw new Error(`Unable to collect git diff for ${projectRoot}: ${detail}`);
  }
}
