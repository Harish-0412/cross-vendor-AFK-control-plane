import { describe, expect, test } from 'vitest';

import { sandboxIsolationCheck } from '../src/runtime/preflight';

/**
 * The sandbox preflight check exists to stop the gateway quietly implying a
 * containment it does not have. These tests are written from that angle: each
 * one asserts that a machine which enforces nothing says so.
 */
describe('sandbox isolation preflight', () => {
  const none = {
    filesystemIsolation: false,
    networkIsolation: false,
    processLimits: false,
    memoryLimits: false,
  };

  test('warns, and names the risk, when nothing is enforced', async () => {
    const result = await sandboxIsolationCheck('win32', none).run();

    expect(result.status).toBe('warn');
    expect(result.message).toContain('No sandbox enforcement');
    // The user has to be able to act on it, so the consequence is spelled out
    // rather than left as "isolation: false".
    expect(result.message).toContain('your own file and network access');
    expect(result.remedy).toBeDefined();
  });

  test('gives Windows a remedy that is actually available on Windows', async () => {
    const windows = await sandboxIsolationCheck('win32', none).run();
    const linux = await sandboxIsolationCheck('linux', none).run();

    // Telling a Windows user to install Docker for a Linux container sandbox
    // would be advice they cannot follow.
    expect(windows.remedy).not.toContain('Docker');
    expect(windows.remedy).toContain('project root');
    expect(linux.remedy).toContain('Docker');
  });

  test('still warns when everything but the filesystem is enforced', async () => {
    const result = await sandboxIsolationCheck('linux', {
      ...none,
      networkIsolation: true,
      processLimits: true,
      memoryLimits: true,
    }).run();

    // Memory and process caps do not stop an agent reading your SSH keys, so a
    // partial sandbox is not reported as a pass.
    expect(result.status).toBe('warn');
    expect(result.message).toContain('filesystem not');
  });

  test('passes only when the filesystem is contained, and lists what is in force', async () => {
    const result = await sandboxIsolationCheck('darwin', {
      filesystemIsolation: true,
      networkIsolation: true,
      processLimits: false,
      memoryLimits: false,
    }).run();

    expect(result.status).toBe('pass');
    expect(result.message).toContain('filesystem');
    expect(result.message).toContain('network');
    expect(result.message).not.toContain('memory limits');
  });
});
