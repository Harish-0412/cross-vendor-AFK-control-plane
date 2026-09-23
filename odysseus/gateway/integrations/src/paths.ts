/**
 * Where things live on the workstation.
 *
 * Every root is derived from the home directory at call time, so tests can
 * point `home` at a temporary directory instead of the real user profile.
 */
import { homedir } from 'node:os';
import { join } from 'node:path';

import type { IntegrationId } from '@odysseus/protocol';

export interface PathContext {
  /** The user's home directory. */
  home: string;
  /** Odysseus's own state directory — device key, grants, requests. */
  odysseusHome: string;
}

export function defaultPathContext(): PathContext {
  const home = homedir();
  return {
    home,
    odysseusHome: process.env['ODYSSEUS_HOME'] ?? join(home, '.odysseus'),
  };
}

export function grantsFile(ctx: PathContext): string {
  return join(ctx.odysseusHome, 'grants.json');
}

export function requestsFile(ctx: PathContext): string {
  return join(ctx.odysseusHome, 'grant-requests.json');
}

/** Local-only requests written by `pnpm grants terminate-web`. */
export function connectionControlFile(ctx: PathContext): string {
  return join(ctx.odysseusHome, 'connection-control.json');
}

/**
 * The directories each integration may read. Anything outside these, and
 * anything inside them that does not match the integration's allowlist, is
 * refused. `chatgpt-export` has no fixed root: the user names the export file
 * at import time, and that one file becomes the root.
 */
export function integrationRoots(integration: IntegrationId, ctx: PathContext): string[] {
  switch (integration) {
    case 'codex':
      return [join(ctx.home, '.codex', 'sessions')];
    case 'antigravity':
      return [join(ctx.home, '.gemini', 'antigravity', 'brain')];
    case 'claude':
      return [join(ctx.home, '.claude', 'projects')];
    case 'chatgpt-export':
    case 'openai-org':
      return [];
  }
}

/**
 * A path as it is shown off this machine: the home directory becomes `~` and
 * separators become forward slashes. Grants keep the real path; only what is
 * reported to the Control Plane is shortened, so the cloud never learns the
 * local account name from a folder path.
 */
export function displayPath(path: string, ctx: PathContext): string {
  const normalised = path.replace(/\\/g, '/');
  const home = ctx.home.replace(/\\/g, '/');
  const lowerPath = normalised.toLowerCase();
  const lowerHome = home.toLowerCase();
  if (lowerPath === lowerHome) return '~';
  if (lowerPath.startsWith(lowerHome + '/')) return '~' + normalised.slice(home.length);
  return normalised;
}
