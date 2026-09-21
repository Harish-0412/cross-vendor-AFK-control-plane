/**
 * Reading files only through the guard.
 *
 * Nothing in this package opens an integration's files any other way. Listing
 * walks the granted roots without following symlinks; reading re-checks the
 * file against the guard, opens it, and then confirms the opened file is the
 * one that was checked — so swapping a file for a link between the check and
 * the open does not redirect the read.
 */
import { open, readdir, lstat } from 'node:fs/promises';
import { join, relative, sep } from 'node:path';

import type { IntegrationId, IntegrationScope } from '@odysseus/protocol';

import { isAllowedFile } from './allowlist';
import type { GrantGuard } from './grant-guard';

export interface ListedFile {
  absolutePath: string;
  /** Relative to the granted root, forward slashes. */
  relativePath: string;
  size: number;
  mtimeMs: number;
}

export interface ListOptions {
  maxFiles?: number;
  maxDepth?: number;
}

/** Every allowlisted file under the granted roots. */
export async function listAllowedFiles(
  guard: GrantGuard,
  integration: IntegrationId,
  scope: IntegrationScope,
  options: ListOptions = {},
): Promise<ListedFile[]> {
  const access = await guard.authorize(integration, scope);
  if (!access.allowed) throw new AccessDeniedError(access.reason);

  const maxFiles = options.maxFiles ?? 10_000;
  const maxDepth = options.maxDepth ?? 8;
  const found: ListedFile[] = [];

  async function walk(root: string, dir: string, depth: number): Promise<void> {
    if (depth > maxDepth || found.length >= maxFiles) return;
    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      return; // unreadable directory: skip, do not fail the whole listing
    }
    for (const entry of entries) {
      if (found.length >= maxFiles) return;
      // Dirent reports links as links; they are never followed.
      if (entry.isSymbolicLink()) continue;
      const path = join(dir, entry.name);
      if (entry.isDirectory()) {
        await walk(root, path, depth + 1);
      } else if (entry.isFile()) {
        const relativePath = relative(root, path).split(sep).join('/');
        if (!isAllowedFile(integration, scope, relativePath)) continue;
        const info = await lstat(path).catch(() => null);
        if (!info || !info.isFile()) continue;
        found.push({ absolutePath: path, relativePath, size: info.size, mtimeMs: info.mtimeMs });
      }
    }
  }

  for (const root of access.grant.roots) await walk(root, root, 0);
  return found;
}

export interface ReadLine {
  line: string;
  /** Byte offset where this line starts. */
  start: number;
  /** Byte offset just past its newline — the resume point after this line. */
  end: number;
}

export interface ReadResult {
  lines: ReadLine[];
  /**
   * Where the next read should start. A final line without a newline is a
   * write in progress; it is not returned and this offset stops before it, so
   * the next sync reads it once it is complete.
   */
  nextOffset: number;
  size: number;
}

/**
 * Read complete lines of a granted file, starting at `fromOffset`.
 * Throws AccessDeniedError when the guard refuses.
 */
export async function readGrantedLines(
  guard: GrantGuard,
  integration: IntegrationId,
  scope: IntegrationScope,
  absolutePath: string,
  fromOffset = 0,
): Promise<ReadResult> {
  const decision = await guard.authorizeFile(integration, scope, absolutePath);
  if (!decision.allowed) throw new AccessDeniedError(decision.reason);

  const handle = await open(decision.realPath, 'r');
  try {
    const opened = await handle.stat();
    if (opened.dev !== decision.identity.dev || opened.ino !== decision.identity.ino) {
      throw new AccessDeniedError('file changed between the check and the read');
    }

    const size = opened.size;
    const start = Math.min(Math.max(0, fromOffset), size);
    const length = size - start;
    const buffer = Buffer.alloc(length);
    let read = 0;
    while (read < length) {
      const { bytesRead } = await handle.read(buffer, read, length - read, start + read);
      if (bytesRead === 0) break;
      read += bytesRead;
    }

    const lines: ReadLine[] = [];
    let cursor = 0;
    while (cursor < read) {
      const newline = buffer.indexOf(0x0a, cursor);
      if (newline === -1 || newline >= read) break; // incomplete final line
      let content = buffer.subarray(cursor, newline);
      if (content.length && content[content.length - 1] === 0x0d) content = content.subarray(0, -1);
      lines.push({
        line: content.toString('utf8'),
        start: start + cursor,
        end: start + newline + 1,
      });
      cursor = newline + 1;
    }

    return { lines, nextOffset: start + cursor, size };
  } finally {
    await handle.close();
  }
}

export class AccessDeniedError extends Error {
  constructor(reason: string) {
    super(`Access refused: ${reason}`);
    this.name = 'AccessDeniedError';
  }
}

/**
 * How many files a grant would cover, shown at the workstation before the
 * owner approves. Only directory entries are listed — no file is opened and
 * nothing is sent anywhere. It runs before any grant exists, which is why it
 * does not go through the guard: its whole purpose is to inform that decision.
 */
export async function previewIntegration(
  integration: IntegrationId,
  scopes: IntegrationScope[],
  roots: string[],
): Promise<{ root: string; exists: boolean; matchingFiles: number }[]> {
  const preview = [];
  for (const root of roots) {
    let exists = true;
    let matching = 0;
    const walk = async (dir: string, depth: number): Promise<void> => {
      if (depth > 8 || matching >= 100_000) return;
      let entries;
      try {
        entries = await readdir(dir, { withFileTypes: true });
      } catch {
        if (dir === root) exists = false;
        return;
      }
      for (const entry of entries) {
        if (entry.isSymbolicLink()) continue;
        const path = join(dir, entry.name);
        if (entry.isDirectory()) await walk(path, depth + 1);
        else if (entry.isFile()) {
          const relativePath = relative(root, path).split(sep).join('/');
          if (scopes.some((scope) => isAllowedFile(integration, scope, relativePath)))
            matching += 1;
        }
      }
    };
    await walk(root, 0);
    preview.push({ root, exists, matchingFiles: matching });
  }
  return preview;
}
