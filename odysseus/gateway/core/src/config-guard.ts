/**
 * The deny floor, enforced after the fact for agents Odysseus cannot stop
 * mid-action.
 *
 * Most agent CLIs run with no per-action hook (their `approvalInterception`
 * is `unsupported`), so the policy engine never sees their individual file
 * writes. That is exactly how a prompt-injected agent would plant a
 * malicious `.cursor/mcp.json`, a git hook or a Claude Code hook. This guard
 * remembers those files before an agent starts, checks them while it runs
 * and when it ends, and:
 *
 *  - in the project, puts the original back and keeps the agent's version in
 *    a quarantine folder, so nothing is lost if the change was the person's;
 *  - in the home folder, reports the change but leaves it, because the
 *    person's own tools rewrite those files too.
 *
 * For `.git/config` and `~/.gitconfig` only settings git executes count:
 * `git push -u` legitimately records an upstream branch there.
 */
import { createHash } from 'node:crypto';
import { promises as fs } from 'node:fs';
import { dirname, join, relative, sep } from 'node:path';

import {
  executingGitConfig,
  PROTECTED_CONFIG_DIRECTORIES,
  PROTECTED_CONFIG_FILES,
} from '@odysseus/policy-engine';

/** Larger files are fingerprinted but never copied or restored. */
const MAX_COPY_BYTES = 1024 * 1024;
const GIT_CONFIG_FILES = new Set(['.git/config', '.gitconfig']);

export interface ProtectedConfigGuardOptions {
  /** The person's home folder. */
  home: string;
  /** Where changed versions are kept, one folder per session and check. */
  quarantineDir: string;
  now?: () => Date;
}

interface Entry {
  /** Absolute path. */
  path: string;
  /** How the change is described: `.cursor/mcp.json` or `~/.gitconfig`. */
  label: string;
  scope: 'project' | 'home';
  /** The file as it was, or null when it did not exist. */
  content: Buffer | null;
  fingerprint: string | null;
}

export interface ConfigSnapshot {
  projectRoot: string;
  entries: Map<string, Entry>;
  /** Directories whose new files count as changes. */
  watchedDirectories: Array<{ path: string; label: string; scope: 'project' | 'home' }>;
}

export interface ConfigChange {
  path: string;
  scope: 'project' | 'home';
  change: 'modified' | 'created' | 'deleted';
  restored: boolean;
  /** Where the changed version was kept, when there was one to keep. */
  quarantinedTo?: string;
}

export class ProtectedConfigGuard {
  private readonly now: () => Date;

  constructor(private readonly options: ProtectedConfigGuardOptions) {
    this.now = options.now ?? (() => new Date());
  }

  /** Remember the protected files as they are before the agent starts. */
  async snapshot(projectRoot: string): Promise<ConfigSnapshot> {
    const snapshot: ConfigSnapshot = { projectRoot, entries: new Map(), watchedDirectories: [] };
    const places: Array<{ root: string; scope: 'project' | 'home'; prefix: string }> = [
      { root: projectRoot, scope: 'project', prefix: '' },
      { root: this.options.home, scope: 'home', prefix: '~/' },
    ];
    for (const place of places) {
      for (const file of PROTECTED_CONFIG_FILES) {
        await this.remember(
          snapshot,
          join(place.root, file),
          `${place.prefix}${file}`,
          place.scope,
        );
      }
      for (const directory of PROTECTED_CONFIG_DIRECTORIES) {
        // The gateway keeps its own state in ~/.odysseus; only the project's copy is guarded.
        if (place.scope === 'home' && directory === '.odysseus') continue;
        const path = join(place.root, directory);
        snapshot.watchedDirectories.push({
          path,
          label: `${place.prefix}${directory}`,
          scope: place.scope,
        });
        for (const file of await listFiles(path)) {
          await this.remember(
            snapshot,
            file,
            `${place.prefix}${directory}/${toPosix(relative(path, file))}`,
            place.scope,
          );
        }
      }
    }
    return snapshot;
  }

  /**
   * Compare against the snapshot. Changed project files are put back (their
   * changed version quarantined); home files are only reported. The snapshot
   * is updated so a change is reported once.
   */
  async check(snapshot: ConfigSnapshot, sessionId: string): Promise<ConfigChange[]> {
    // Files that appeared in a watched directory since the snapshot.
    for (const directory of snapshot.watchedDirectories) {
      for (const file of await listFiles(directory.path)) {
        if (snapshot.entries.has(file)) continue;
        snapshot.entries.set(file, {
          path: file,
          label: `${directory.label}/${toPosix(relative(directory.path, file))}`,
          scope: directory.scope,
          content: null,
          fingerprint: null,
        });
      }
    }

    const changes: ConfigChange[] = [];
    const stamp = this.now().toISOString().replace(/[:.]/g, '-');
    for (const entry of snapshot.entries.values()) {
      const current = await readIfSmall(entry.path);
      const fingerprint = current.exists ? fingerprintOf(entry.label, current) : null;
      if (fingerprint === entry.fingerprint) continue;

      const change: ConfigChange['change'] =
        entry.fingerprint === null ? 'created' : fingerprint === null ? 'deleted' : 'modified';
      const result: ConfigChange = {
        path: entry.label,
        scope: entry.scope,
        change,
        restored: false,
      };

      if (entry.scope === 'project' && (entry.content !== null || entry.fingerprint === null)) {
        if (current.exists && current.content) {
          const kept = join(
            this.options.quarantineDir,
            sanitise(sessionId),
            stamp,
            ...entry.label.split('/').map(sanitise),
          );
          await fs.mkdir(dirname(kept), { recursive: true });
          await fs.writeFile(kept, current.content);
          result.quarantinedTo = kept;
        }
        if (entry.content === null) await fs.rm(entry.path, { force: true });
        else {
          await fs.mkdir(dirname(entry.path), { recursive: true });
          await fs.writeFile(entry.path, entry.content);
        }
        result.restored = true;
      } else {
        // Reported once: from now on the new state is the baseline.
        entry.fingerprint = fingerprint;
        entry.content = current.content ?? null;
      }
      changes.push(result);
    }
    return changes;
  }

  private async remember(
    snapshot: ConfigSnapshot,
    path: string,
    label: string,
    scope: 'project' | 'home',
  ): Promise<void> {
    const current = await readIfSmall(path);
    snapshot.entries.set(path, {
      path,
      label,
      scope,
      content: current.content ?? null,
      fingerprint: current.exists ? fingerprintOf(label, current) : null,
    });
  }
}

/** Plain-language description of a set of changes, for the violation event. */
export function describeConfigChanges(changes: ConfigChange[]): string {
  const restored = changes.filter((change) => change.restored).map((change) => change.path);
  const reported = changes.filter((change) => !change.restored).map((change) => change.path);
  const parts: string[] = [];
  if (restored.length > 0)
    parts.push(
      `A protected file changed while the agent ran: ${restored.join(', ')}. Odysseus put the previous version back and kept the changed copy; if you made this change yourself, copy it back from there.`,
    );
  if (reported.length > 0)
    parts.push(
      `A protected file in your home folder changed while the agent ran: ${reported.join(', ')}. It was left as it is; check that you or one of your own tools made this change.`,
    );
  return parts.join(' ');
}

async function readIfSmall(
  path: string,
): Promise<{ exists: boolean; content?: Buffer; size?: number; mtime?: number }> {
  try {
    const stat = await fs.stat(path);
    if (!stat.isFile()) return { exists: false };
    if (stat.size > MAX_COPY_BYTES) return { exists: true, size: stat.size, mtime: stat.mtimeMs };
    return { exists: true, content: await fs.readFile(path) };
  } catch {
    return { exists: false };
  }
}

function fingerprintOf(
  label: string,
  current: { content?: Buffer; size?: number; mtime?: number },
): string {
  if (!current.content) return `large:${current.size}:${current.mtime}`;
  const name = label.replace(/^~\//, '');
  const body = GIT_CONFIG_FILES.has(name)
    ? executingGitConfig(current.content.toString('utf8')).join('\n')
    : current.content;
  return createHash('sha256').update(body).digest('hex');
}

async function listFiles(directory: string): Promise<string[]> {
  const found: string[] = [];
  let names: string[];
  try {
    names = await fs.readdir(directory);
  } catch {
    return found;
  }
  for (const name of names) {
    const path = join(directory, name);
    try {
      const stat = await fs.stat(path);
      if (stat.isDirectory()) found.push(...(await listFiles(path)));
      else if (stat.isFile()) found.push(path);
    } catch {
      /* removed while listing */
    }
  }
  return found;
}

function toPosix(path: string): string {
  return path.split(sep).join('/');
}

function sanitise(part: string): string {
  return part.replace(/^~$/, 'home').replace(/[^A-Za-z0-9._-]/g, '_');
}
