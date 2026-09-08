import { PassThrough } from 'node:stream';
import { execFile } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { describe, expect, it, vi } from 'vitest';
import type { Sandbox, SessionConfig } from '@freebuff/protocol';
import { OpenCodeAdapter } from '../src/opencode-adapter';
import type { OpenCodeProcessController } from '../src/process-manager';

const execFileAsync = promisify(execFile);

function fakeController(): OpenCodeProcessController {
  const stdout = new PassThrough();
  const sandbox = { id: 'sb_opencode', pid: 42, stdout, stdin: new PassThrough(), stderr: new PassThrough() } as unknown as Sandbox;
  return {
    detect: vi.fn().mockResolvedValue({ path: '/fake/opencode', version: '1.18.23' }),
    validate: vi.fn().mockResolvedValue({ valid: true, version: '1.18.23', errors: [] }),
    start: vi.fn().mockResolvedValue(sandbox), stop: vi.fn().mockResolvedValue(undefined),
    getSandbox: vi.fn().mockReturnValue(sandbox),
    watchStdout: vi.fn((_sandbox, onLine) => { onLine('{"type":"text","part":{"type":"text","text":"hello"}}'); }),
  };
}

describe('OpenCodeAdapter', () => {
  it('uses the sandbox process controller and exposes normalized output without vendor types', async () => {
    const controller = fakeController();
    const adapter = new OpenCodeAdapter(controller);
    expect((await adapter.installOrDetect()).installedVersion).toBe('1.18.23');
    expect((await adapter.validateEnvironment()).valid).toBe(true);
    const config: SessionConfig = { projectRoot: '/workspace', adapter: 'opencode', prompt: 'Say hello' };
    const sessionId = await adapter.startSession(config);
    expect(controller.start).toHaveBeenCalledWith(config);
    const stream = adapter.streamEvents(sessionId);
    const first = await stream[Symbol.asyncIterator]().next();
    expect(first.value?.eventType).toBe('session.output');
    expect(adapter.metadata().capabilities.approvalInterception).toBe('unsupported');
    await adapter.abortSession(sessionId, 'test', true);
    expect(controller.stop).toHaveBeenCalledWith(expect.anything(), true);
  });

  it('collects the real unified diff in the session project and is honest about unsupported approvals', async () => {
    const projectRoot = await mkdtemp(join(tmpdir(), 'freebuff-opencode-'));
    try {
      await execFileAsync('git', ['init'], { cwd: projectRoot });
      await execFileAsync('git', ['config', 'user.email', 'test@freebuff.dev'], { cwd: projectRoot });
      await execFileAsync('git', ['config', 'user.name', 'Freebuff Test'], { cwd: projectRoot });
      await writeFile(join(projectRoot, 'greeting.ts'), 'export const greeting = "before";\n');
      await execFileAsync('git', ['add', '.'], { cwd: projectRoot });
      await execFileAsync('git', ['commit', '-m', 'initial'], { cwd: projectRoot });
      await writeFile(join(projectRoot, 'greeting.ts'), 'export const greeting = "after";\n');

      const adapter = new OpenCodeAdapter(fakeController());
      const sessionId = await adapter.startSession({ projectRoot, adapter: 'opencode', prompt: 'Change greeting' });
      await expect(adapter.requestApproval(sessionId, {
        id: 'appr_1', type: 'bash_exec', description: 'git push', riskLevel: 'critical', details: {},
      })).rejects.toThrow('does not expose external approval interception');
      // The fake native stream still emitted agent output: no invisible pause was faked.
      expect((await adapter.streamEvents(sessionId)[Symbol.asyncIterator]().next()).value?.eventType).toBe('session.output');
      expect(await adapter.collectDiff(sessionId)).toContain('-export const greeting = "before";');
      expect(await adapter.collectDiff(sessionId)).toContain('+export const greeting = "after";');
    } finally {
      await rm(projectRoot, { recursive: true, force: true });
    }
  });
});
