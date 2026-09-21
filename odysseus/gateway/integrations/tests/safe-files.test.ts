import { appendFileSync, mkdirSync, openSync, closeSync, ftruncateSync, symlinkSync } from 'node:fs';
import { join } from 'node:path';

import type { IntegrationUpdate } from '@odysseus/protocol';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { MAX_FILE_BYTES } from '../src/grant-guard';
import { IntegrationManager } from '../src/integration-manager';
import { AccessDeniedError, listAllowedFiles, readGrantedLines } from '../src/safe-files';

import { CODE, createHome, createSigner, makeRequest, writeFile } from './helpers';

/**
 * Reading through the guard. The files an integration may open are an
 * allowlist; these tests try to reach files that are not on it.
 */
describe('safe file access', () => {
  let home: ReturnType<typeof createHome>;
  let manager: IntegrationManager;
  let updates: IntegrationUpdate[];
  let sessions: string;
  let rollout: string;
  let authJson: string;

  beforeEach(async () => {
    home = createHome();
    sessions = join(home.home, '.codex', 'sessions');
    rollout = writeFile(
      join(sessions, '2026', '09', '21', 'rollout-2026-09-21T10-00-00-aaaa.jsonl'),
      '{"a":1}\n{"b":2}\n',
    );
    authJson = writeFile(join(home.home, '.codex', 'auth.json'), '{"token":"secret"}');
    writeFile(join(sessions, 'notes.txt'), 'not a session');

    updates = [];
    manager = new IntegrationManager({
      signer: createSigner(),
      ctx: home,
      onUpdate: (update) => updates.push(update),
    });
    const request = makeRequest('codex', ['history.read']);
    await manager.receiveRequest(request);
    await manager.approve(request.requestId, CODE, { interactive: true });
  });

  afterEach(() => home.cleanup());

  it('reads an allowlisted session file', async () => {
    const result = await readGrantedLines(manager.guard, 'codex', 'history.read', rollout);
    expect(result.lines.map((line) => line.line)).toEqual(['{"a":1}', '{"b":2}']);
  });

  it('never opens auth.json, even with an active grant', async () => {
    await expect(
      readGrantedLines(manager.guard, 'codex', 'history.read', authJson),
    ).rejects.toBeInstanceOf(AccessDeniedError);
  });

  it('does not list auth.json or other unlisted files', async () => {
    const files = await listAllowedFiles(manager.guard, 'codex', 'history.read');
    expect(files.map((file) => file.relativePath)).toEqual([
      '2026/09/21/rollout-2026-09-21T10-00-00-aaaa.jsonl',
    ]);
  });

  it('refuses a file inside the folder that is not on the allowlist', async () => {
    await expect(
      readGrantedLines(manager.guard, 'codex', 'history.read', join(sessions, 'notes.txt')),
    ).rejects.toThrow(/allowlist/);
  });

  it('refuses ../ traversal out of the granted folder', async () => {
    const traversal = `${sessions}${'/..'}/auth.json`;
    await expect(
      readGrantedLines(manager.guard, 'codex', 'history.read', traversal),
    ).rejects.toThrow(/outside the granted folders/);
  });

  it('refuses a relative path', async () => {
    await expect(
      readGrantedLines(manager.guard, 'codex', 'history.read', '2026/09/21/x.jsonl'),
    ).rejects.toThrow(/absolute/);
  });

  it('does not follow a directory link placed inside the granted folder', async () => {
    // A junction needs no special privileges on Windows, so this runs everywhere.
    const link = join(sessions, '2026', '09', '22');
    mkdirSync(join(sessions, '2026', '09'), { recursive: true });
    symlinkSync(join(home.home, '.codex'), link, 'junction');

    const files = await listAllowedFiles(manager.guard, 'codex', 'history.read');
    expect(files.some((file) => file.relativePath.startsWith('2026/09/22'))).toBe(false);

    // Reaching through the link resolves outside the root and is refused.
    await expect(
      readGrantedLines(manager.guard, 'codex', 'history.read', join(link, 'auth.json')),
    ).rejects.toBeInstanceOf(AccessDeniedError);
  });

  it('refuses a file over the size limit', async () => {
    const big = join(sessions, '2026', '09', '21', 'rollout-2026-09-21T11-00-00-bbbb.jsonl');
    writeFile(big, '');
    const fd = openSync(big, 'r+');
    ftruncateSync(fd, MAX_FILE_BYTES + 1);
    closeSync(fd);
    await expect(readGrantedLines(manager.guard, 'codex', 'history.read', big)).rejects.toThrow(/size limit/);
  });

  it('holds back a half-written last line and resumes it once complete', async () => {
    appendFileSync(rollout, '{"partial":');
    const first = await readGrantedLines(manager.guard, 'codex', 'history.read', rollout);
    expect(first.lines).toHaveLength(2);

    appendFileSync(rollout, 'true}\n');
    const second = await readGrantedLines(manager.guard, 'codex', 'history.read', rollout, first.nextOffset);
    expect(second.lines.map((line) => line.line)).toEqual(['{"partial":true}']);
  });

  it('handles Windows line endings', async () => {
    const crlf = writeFile(
      join(sessions, '2026', '09', '21', 'rollout-2026-09-21T12-00-00-cccc.jsonl'),
      '{"x":1}\r\n{"y":2}\r\n',
    );
    const result = await readGrantedLines(manager.guard, 'codex', 'history.read', crlf);
    expect(result.lines.map((line) => line.line)).toEqual(['{"x":1}', '{"y":2}']);
  });

  it('refuses reads for a scope that was not granted', async () => {
    await expect(readGrantedLines(manager.guard, 'codex', 'usage.read', rollout)).rejects.toThrow(
      /does not include usage.read/,
    );
  });

  it('reports refused paths relative to the root, never as absolute paths', async () => {
    await readGrantedLines(manager.guard, 'codex', 'history.read', join(sessions, 'notes.txt')).catch(
      () => undefined,
    );
    const refusal = updates.find((u) => u.kind === 'access_refused');
    expect(refusal && refusal.kind === 'access_refused' && refusal.target).toBe('notes.txt');
    expect(JSON.stringify(updates)).not.toContain(home.home.replace(/\\/g, '\\\\'));
  });
});
