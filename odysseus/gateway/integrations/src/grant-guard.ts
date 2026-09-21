/**
 * The check that runs before every read.
 *
 * This is the enforcement point. The web app and the Control Plane also check,
 * but only this runs where the data is, so a stolen web session or a
 * compromised Control Plane cannot talk its way past it: without a grant this
 * device signed, nothing is read.
 */
import { lstat, realpath } from 'node:fs/promises';
import { isAbsolute, relative, sep } from 'node:path';

import type { IntegrationId, IntegrationScope } from '@odysseus/protocol';

import { isAllowedFile } from './allowlist';
import type { GrantStore, StoredGrant } from './grant-store';

/** Larger than any real session file seen (22 MB), small enough to bound memory and time. */
export const MAX_FILE_BYTES = 64 * 1024 * 1024;

export type AccessDecision =
  { allowed: true; grant: StoredGrant } | { allowed: false; reason: string };

export type FileDecision =
  | {
      allowed: true;
      grant: StoredGrant;
      realPath: string;
      relativePath: string;
      size: number;
      /** Identity of the file at check time, compared again after opening. */
      identity: { dev: number; ino: number };
    }
  | { allowed: false; reason: string; relativePath?: string | undefined };

export interface RefusalListener {
  (refusal: {
    integration: IntegrationId;
    scope: IntegrationScope;
    reason: string;
    target?: string | undefined;
  }): void;
}

export class GrantGuard {
  constructor(
    private readonly store: GrantStore,
    private readonly onRefused: RefusalListener = () => undefined,
    private readonly now: () => number = Date.now,
  ) {}

  /** Checks 1–2: a valid grant exists and includes the scope. */
  async authorize(integration: IntegrationId, scope: IntegrationScope): Promise<AccessDecision> {
    const grant = await this.store.findActive(integration, this.now());
    if (!grant) return this.refuse(integration, scope, 'no active grant for this integration');
    if (!grant.scopes.includes(scope)) {
      return this.refuse(integration, scope, `grant does not include ${scope}`);
    }
    return { allowed: true, grant };
  }

  /**
   * Checks 1–5 for one file: grant, scope, real path inside a granted root,
   * allowlist match, not a symlink, within the size cap.
   */
  async authorizeFile(
    integration: IntegrationId,
    scope: IntegrationScope,
    requestedPath: string,
  ): Promise<FileDecision> {
    const access = await this.authorize(integration, scope);
    if (!access.allowed) return access;

    if (!isAbsolute(requestedPath)) {
      return this.refuseFile(integration, scope, 'path must be absolute');
    }

    // Symlinks are refused outright rather than followed. A link inside a
    // granted root can point anywhere, and following it safely would mean
    // re-checking the target — refusing is simpler and loses nothing real.
    let linkInfo;
    try {
      linkInfo = await lstat(requestedPath);
    } catch {
      return this.refuseFile(integration, scope, 'file does not exist');
    }
    if (linkInfo.isSymbolicLink()) {
      return this.refuseFile(integration, scope, 'symbolic links are not followed');
    }
    if (!linkInfo.isFile()) return this.refuseFile(integration, scope, 'not a regular file');

    // Resolve the real path before comparing, so `..` segments and linked
    // parent directories cannot smuggle a path outside the root.
    let realPath: string;
    try {
      realPath = await realpath(requestedPath);
    } catch {
      return this.refuseFile(integration, scope, 'path could not be resolved');
    }

    const root = access.grant.roots.find((candidate) => isInside(realPath, candidate));
    if (!root) return this.refuseFile(integration, scope, 'outside the granted folders');

    const relativePath = relative(root, realPath).split(sep).join('/');
    if (!isAllowedFile(integration, scope, relativePath)) {
      return this.refuseFile(integration, scope, 'file is not on the allowlist', relativePath);
    }
    if (linkInfo.size > MAX_FILE_BYTES) {
      return this.refuseFile(integration, scope, 'file exceeds the size limit', relativePath);
    }

    return {
      allowed: true,
      grant: access.grant,
      realPath,
      relativePath,
      size: linkInfo.size,
      identity: { dev: linkInfo.dev, ino: linkInfo.ino },
    };
  }

  private refuse(integration: IntegrationId, scope: IntegrationScope, reason: string) {
    this.onRefused({ integration, scope, reason });
    return { allowed: false as const, reason };
  }

  private refuseFile(
    integration: IntegrationId,
    scope: IntegrationScope,
    reason: string,
    relativePath?: string,
  ) {
    // Only the path relative to the root is reported, never an absolute path:
    // the audit trail should not become a map of the user's disk.
    this.onRefused({ integration, scope, reason, target: relativePath });
    return { allowed: false as const, reason, relativePath };
  }
}

/** True when `child` is `root` itself or somewhere beneath it. */
export function isInside(child: string, root: string): boolean {
  const rel = relative(root, child);
  return rel === '' || (!!rel && !rel.startsWith('..') && !isAbsolute(rel));
}
