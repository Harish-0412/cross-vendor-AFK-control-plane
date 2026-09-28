import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

/**
 * Collect the working-tree diff for a project.
 *
 * Non-shell invocation with a bounded timeout and buffer, matching the pattern
 * the Gateway's ProjectManager uses. Staged changes are included because an
 * agent that ran `git add` has still not committed — the user reviewing the
 * session needs to see that work.
 */
export async function safeGitDiff(projectRoot: string): Promise<string> {
  try {
    const { stdout } = await execFileAsync(
      'git',
      ['diff', 'HEAD', '--no-ext-diff', '--binary', '--'],
      {
        cwd: projectRoot,
        timeout: 10_000,
        windowsHide: true,
        maxBuffer: 20 * 1024 * 1024,
      },
    );
    return stdout;
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    // A project that is not a git repository is a legitimate state, not a
    // crash: report it as an empty diff with an explanatory header.
    if (/not a git repository/i.test(detail)) {
      return `# ${projectRoot} is not a git repository; no diff available\n`;
    }
    throw new Error(`Unable to collect git diff for ${projectRoot}: ${detail}`);
  }
}
