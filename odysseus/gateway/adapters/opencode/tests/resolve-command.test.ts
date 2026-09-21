import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { resolveCommand } from '../src/resolve-command';

/**
 * On Windows, npm-installed CLIs are `.cmd` shims that `spawn` cannot run
 * without a shell — and a shell would make the session prompt (an argument)
 * injectable. These tests pin the shim formats npm actually writes, so the
 * resolver keeps finding the real target instead of reporting the agent as
 * not installed.
 */
describe('resolveCommand', () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'odysseus-resolve-'));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  const win = (pathValue: string) => ({
    platform: 'win32' as const,
    env: { Path: pathValue },
    nodePath: 'C:\\node\\node.exe',
  });

  it('leaves the name untouched off Windows', () => {
    expect(resolveCommand('opencode', { platform: 'linux' })).toEqual({
      command: 'opencode',
      prefixArgs: [],
    });
  });

  it('prefers a real .exe on PATH', () => {
    writeFileSync(join(dir, 'tool.exe'), '');
    expect(resolveCommand('tool', win(dir))).toEqual({
      command: join(dir, 'tool.exe'),
      prefixArgs: [],
    });
  });

  it('unwraps a shim that launches a native binary (the OpenCode shape)', () => {
    const target = join(dir, 'node_modules', 'opencode-ai', 'bin');
    mkdirSync(target, { recursive: true });
    writeFileSync(join(target, 'opencode.exe'), '');
    writeFileSync(
      join(dir, 'opencode.cmd'),
      [
        '@ECHO off',
        'GOTO start',
        ':find_dp0',
        'SET dp0=%~dp0',
        'EXIT /b',
        ':start',
        'SETLOCAL',
        'CALL :find_dp0',
        '"%dp0%\\node_modules\\opencode-ai\\bin\\opencode.exe"   %*',
      ].join('\r\n'),
    );

    expect(resolveCommand('opencode', win(dir))).toEqual({
      command: join(target, 'opencode.exe'),
      prefixArgs: [],
    });
  });

  it('unwraps a shim that runs a node script, via node rather than a shell', () => {
    const target = join(dir, 'node_modules', '@anthropic-ai', 'claude-code');
    mkdirSync(target, { recursive: true });
    writeFileSync(join(target, 'cli.js'), '');
    writeFileSync(
      join(dir, 'claude.cmd'),
      [
        '@ECHO off',
        'SETLOCAL',
        'CALL :find_dp0',
        'IF EXIST "%dp0%\\node.exe" (',
        '  SET "_prog=%dp0%\\node.exe"',
        ') ELSE (',
        '  SET "_prog=node"',
        ')',
        '"%_prog%"  "%dp0%\\node_modules\\@anthropic-ai\\claude-code\\cli.js" %*',
      ].join('\r\n'),
    );

    // The local node.exe mention is the interpreter, not the target.
    expect(resolveCommand('claude', win(dir))).toEqual({
      command: 'C:\\node\\node.exe',
      prefixArgs: [join(target, 'cli.js')],
    });
  });

  it('falls back to the bare name when nothing is found', () => {
    expect(resolveCommand('missing-tool', win(dir))).toEqual({
      command: 'missing-tool',
      prefixArgs: [],
    });
  });

  it('does not resolve a shim whose target is missing', () => {
    writeFileSync(join(dir, 'broken.cmd'), '"%dp0%\\node_modules\\gone\\bin\\gone.exe" %*');
    expect(resolveCommand('broken', win(dir))).toEqual({
      command: 'broken',
      prefixArgs: [],
    });
  });
});
