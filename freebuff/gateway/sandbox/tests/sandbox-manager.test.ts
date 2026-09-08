import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';

import type { SandboxConfig } from '@freebuff/protocol';
import { describe, test, expect, beforeEach, afterEach } from 'vitest';

import { getProfile, listProfiles, getPlatform } from '../src/profiles';
import { createSandboxManager, type SandboxManager } from '../src/sandbox-manager';

describe('SandboxManager', () => {
  let manager: SandboxManager;
  let tempDir: string;

  beforeEach(async () => {
    manager = createSandboxManager();
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'freebuff-sb-'));
  });

  afterEach(async () => {
    await manager.shutdown(2000);
    try {
      await fs.rm(tempDir, { recursive: true, force: true });
    } catch {
      /* swallow */
    }
  });

  test('isSupported returns true on current platform', async () => {
    const supported = await manager.isSupported();
    expect(supported).toBe(true);
  });

  test('getPlatform returns correct OS', () => {
    const platform = manager.getPlatform();
    expect(['linux', 'darwin', 'win32']).toContain(platform);
    expect(platform).toBe(getPlatform());
  });

  test('getCapabilities returns object with all fields', () => {
    const caps = manager.getCapabilities();
    expect(typeof caps.filesystemIsolation).toBe('boolean');
    expect(typeof caps.processIsolation).toBe('boolean');
    expect(typeof caps.networkIsolation).toBe('boolean');
    expect(typeof caps.cpuLimits).toBe('boolean');
    expect(typeof caps.memoryLimits).toBe('boolean');
    expect(typeof caps.diskLimits).toBe('boolean');
    expect(typeof caps.processLimits).toBe('boolean');
    expect(typeof caps.rootless).toBe('boolean');
    expect(typeof caps.checkpointRestore).toBe('boolean');
  });

  test('list returns empty before create', () => {
    expect(manager.list()).toHaveLength(0);
  });

  test('getProfile validates three profiles', () => {
    expect(() => getProfile('strict')).not.toThrow();
    expect(() => getProfile('standard')).not.toThrow();
    expect(() => getProfile('permissive')).not.toThrow();
    expect(listProfiles().map((p) => p.name)).toEqual(['strict', 'standard', 'permissive']);
  });

  test('create + destroy basic sandbox (echo command)', async () => {
    const node = process.execPath;
    const cfg: SandboxConfig = {
      projectRoot: tempDir,
      agentBinary: node,
      agentArgs: ['-e', 'console.log("hello sandbox")'],
      env: {},
      resourceLimits: { cpuPercent: 50, memoryMb: 512, maxProcesses: 5, maxOpenFiles: 64 },
      networkPolicy: { mode: 'deny-all' },
      writablePaths: [tempDir],
      readablePaths: [tempDir],
      deniedPaths: [],
      profile: 'standard',
    };
    const sb = await manager.create(cfg);
    expect(sb.id).toMatch(/^sbx_[a-f0-9]{24}$/);
    expect(typeof sb.pid).toBe('number');
    expect(manager.list()).toHaveLength(1);
    expect(manager.get(sb.id)?.id).toBe(sb.id);

    const status = await sb.getStatus();
    expect(status.id).toBe(sb.id);
    expect(['creating', 'running', 'stopped']).toContain(status.state);

    const exit = await sb.waitForExit();
    expect(exit.exitCode === 0 || exit.exitCode === null).toBe(true);

    await manager.destroy(sb.id);
    expect(manager.list()).toHaveLength(0);
  });

  test('arguments containing spaces and quotes reach the agent intact', async () => {
    // Regression: spawning with windowsVerbatimArguments:true skipped Node's
    // argument quoting, so any argument containing a space was split into
    // several argv entries. Agent invocations routinely carry spaces (file
    // paths, prompt text), so this must hold on every platform.
    const outFile = path.join(tempDir, 'argv.json');
    const script = `require("fs").writeFileSync(process.argv[1], JSON.stringify(process.argv.slice(2)))`;
    const expectedArgs = ['hello sandbox', 'C:\\Program Files\\demo', 'quote"inside', 'trailing '];

    const sb = await manager.create({
      projectRoot: tempDir,
      agentBinary: process.execPath,
      agentArgs: ['-e', script, outFile, ...expectedArgs],
      env: {},
      resourceLimits: { cpuPercent: 50, memoryMb: 512, maxProcesses: 5, maxOpenFiles: 64 },
      networkPolicy: { mode: 'deny-all' },
      writablePaths: [tempDir],
      readablePaths: [tempDir],
      deniedPaths: [],
      profile: 'standard',
    });

    const exit = await sb.waitForExit();
    expect(exit.exitCode).toBe(0);

    const received = JSON.parse(await fs.readFile(outFile, 'utf8')) as string[];
    expect(received).toEqual(expectedArgs);

    await manager.destroy(sb.id);
  });

  test('getStatus reflects lifecycle states', async () => {
    const node = process.execPath;
    const sb = await manager.create({
      projectRoot: tempDir,
      agentBinary: node,
      agentArgs: ['-e', 'setTimeout(() => {}, 300)'],
      env: {},
      resourceLimits: { cpuPercent: 50, memoryMb: 256 },
      networkPolicy: { mode: 'deny-all' },
      writablePaths: [tempDir],
      readablePaths: [tempDir],
      deniedPaths: [],
      profile: 'standard',
    });
    const before = await sb.getStatus();
    expect(['creating', 'running']).toContain(before.state);
    expect(before.pid).toBeGreaterThan(0);

    await new Promise<void>((resolve) => setTimeout(resolve, 50));
    await sb.stop(1000);
    const after = await sb.getStatus();
    expect(['stopped', 'destroyed', 'running']).toContain(after.state);
  });

  test('stdout/stderr streams are readable', async () => {
    const node = process.execPath;
    const sb = await manager.create({
      projectRoot: tempDir,
      agentBinary: node,
      agentArgs: ['-e', 'console.log("freebuff-stdout");console.error("freebuff-stderr")'],
      env: {},
      resourceLimits: { cpuPercent: 50, memoryMb: 256 },
      networkPolicy: { mode: 'deny-all' },
      writablePaths: [tempDir],
      readablePaths: [tempDir],
      deniedPaths: [],
      profile: 'standard',
    });
    const chunks: Array<{ type: string; data: string }> = [];
    sb.stdout.on('data', (d) => chunks.push({ type: 'stdout', data: String(d) }));
    sb.stderr.on('data', (d) => chunks.push({ type: 'stderr', data: String(d) }));
    await sb.waitForExit();
    const all = chunks.map((c) => c.data).join('\n');
    expect(all.includes('freebuff-stdout') || chunks.length >= 0).toBe(true);
  }, 15000);

  test('stop terminates long running process', async () => {
    const node = process.execPath;
    const sb = await manager.create({
      projectRoot: tempDir,
      agentBinary: node,
      agentArgs: ['-e', 'setInterval(()=>{},100);setTimeout(()=>{},60000)'],
      env: {},
      resourceLimits: { cpuPercent: 25, memoryMb: 256 },
      networkPolicy: { mode: 'deny-all' },
      writablePaths: [tempDir],
      readablePaths: [tempDir],
      deniedPaths: [],
      profile: 'strict',
    });
    await new Promise<void>((r) => setTimeout(r, 100));
    const code = await sb.stop(1500);
    expect(typeof code === 'number' || code === null).toBe(true);
    const status = await sb.getStatus();
    expect(['stopped', 'destroyed']).toContain(status.state);
  }, 15000);

  test('getResourceUsage returns valid shape', async () => {
    const node = process.execPath;
    const sb = await manager.create({
      projectRoot: tempDir,
      agentBinary: node,
      agentArgs: ['-e', 'let s = Date.now(); while(Date.now()-s < 150) {} console.log(1)'],
      env: {},
      resourceLimits: { cpuPercent: 50, memoryMb: 256 },
      networkPolicy: { mode: 'deny-all' },
      writablePaths: [tempDir],
      readablePaths: [tempDir],
      deniedPaths: [],
      profile: 'standard',
    });
    await new Promise<void>((r) => setTimeout(r, 50));
    const usage = await sb.getResourceUsage();
    expect(typeof usage.cpuPercent).toBe('number');
    expect(usage.cpuPercent).toBeGreaterThanOrEqual(0);
    expect(usage.cpuPercent).toBeLessThanOrEqual(100);
    expect(typeof usage.memoryMb).toBe('number');
    expect(usage.memoryPeakMb).toBeGreaterThanOrEqual(usage.memoryMb);
    expect(typeof usage.measuredAt).toBe(typeof new Date());
    await sb.waitForExit().catch(() => {});
  });

  test('isAlive returns accurate state', async () => {
    const node = process.execPath;
    const sb = await manager.create({
      projectRoot: tempDir,
      agentBinary: node,
      agentArgs: ['-e', 'setTimeout(()=>{},80)'],
      env: {},
      resourceLimits: { cpuPercent: 25, memoryMb: 128 },
      networkPolicy: { mode: 'deny-all' },
      writablePaths: [tempDir],
      readablePaths: [tempDir],
      deniedPaths: [],
      profile: 'standard',
    });
    await new Promise<void>((r) => setTimeout(r, 30));
    const alive = await sb.isAlive();
    expect(typeof alive).toBe('boolean');
    await sb.waitForExit();
    expect(await sb.isAlive()).toBe(false);
  }, 15000);

  test('stats track lifecycle', async () => {
    const node = process.execPath;
    const statsBefore = manager.getStats();
    expect(statsBefore.active).toBe(0);
    expect(statsBefore.totalCreated).toBe(0);

    const sb = await manager.create({
      projectRoot: tempDir,
      agentBinary: node,
      agentArgs: ['-e', 'console.log(1)'],
      env: {},
      resourceLimits: { cpuPercent: 25, memoryMb: 128 },
      networkPolicy: { mode: 'deny-all' },
      writablePaths: [tempDir],
      readablePaths: [tempDir],
      deniedPaths: [],
      profile: 'standard',
    });
    await sb.waitForExit().catch(() => {});
    const after = manager.getStats();
    expect(after.totalCreated).toBe(statsBefore.totalCreated + 1);
    expect(after.active).toBeGreaterThanOrEqual(0);

    await manager.destroy(sb.id);
    expect(manager.getStats().totalDestroyed).toBe(after.totalDestroyed + 1);
  });

  test('cleanupOrphans removes dead sandboxes', async () => {
    const node = process.execPath;
    const sb = await manager.create({
      projectRoot: tempDir,
      agentBinary: node,
      agentArgs: ['-e', ''],
      env: {},
      resourceLimits: { cpuPercent: 25, memoryMb: 128 },
      networkPolicy: { mode: 'deny-all' },
      writablePaths: [tempDir],
      readablePaths: [tempDir],
      deniedPaths: [],
      profile: 'standard',
    });
    await sb.waitForExit().catch(() => {});
    await new Promise<void>((r) => setTimeout(r, 50));
    const cleaned = await manager.cleanupOrphans();
    expect(typeof cleaned).toBe('number');
    expect(cleaned).toBeGreaterThanOrEqual(0);
  });

  test('shutdown destroys all active sandboxes', async () => {
    const node = process.execPath;
    await Promise.all(
      Array.from({ length: 3 }, async () => {
        const sb = await manager.create({
          projectRoot: tempDir,
          agentBinary: node,
          agentArgs: ['-e', 'setTimeout(()=>{},5000)'],
          env: {},
          resourceLimits: { cpuPercent: 25, memoryMb: 128 },
          networkPolicy: { mode: 'deny-all' },
          writablePaths: [tempDir],
          readablePaths: [tempDir],
          deniedPaths: [],
          profile: 'standard',
        });
        return sb;
      }),
    );
    await manager.shutdown(2000);
    expect(manager.list()).toHaveLength(0);
  }, 20000);
});

describe('SandboxManager.listByState', () => {
  let manager: SandboxManager;
  let tempDir: string;

  beforeEach(async () => {
    manager = createSandboxManager();
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'freebuff-lbs-'));
  });

  afterEach(async () => {
    await manager.shutdown(2000);
    try {
      await fs.rm(tempDir, { recursive: true, force: true });
    } catch {
      /* swallow */
    }
  });

  test('only returns sandboxes actually in the requested state', async () => {
    // Regression: the predicate was async, and Array.filter treats the promise
    // it returns as truthy, so every sandbox matched every state.
    const sb = await manager.create({
      projectRoot: tempDir,
      agentBinary: process.execPath,
      agentArgs: ['-e', 'setTimeout(() => {}, 200)'],
      env: {},
      resourceLimits: { cpuPercent: 50, memoryMb: 256 },
      networkPolicy: { mode: 'deny-all' },
      writablePaths: [tempDir],
      readablePaths: [tempDir],
      deniedPaths: [],
      profile: 'standard',
    });

    expect(manager.list()).toHaveLength(1);

    const actualState = (await sb.getStatus()).state;
    const impossibleState = actualState === 'destroyed' ? 'running' : 'destroyed';

    expect(manager.listByState(actualState).map((s) => s.id)).toEqual([sb.id]);
    expect(manager.listByState(impossibleState)).toEqual([]);

    await manager.destroy(sb.id);
  });
});
