import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createSandboxManager } from '../src';

describe('Resource Limits Tests', () => {
  let sandbox: Awaited<ReturnType<typeof createSandboxManager>>;
  const testWorkspace = '/tmp/sandbox-test-workspace';

  beforeAll(async () => {
    sandbox = await createSandboxManager();
    await import('fs/promises').then(fs => fs.mkdir(testWorkspace, { recursive: true }));
  });

  afterAll(async () => {
    await sandbox.shutdown();
    await import('fs/promises').then(fs => fs.rm(testWorkspace, { recursive: true, force: true }));
  });

  it('should enforce CPU limit', async () => {
    const handle = await sandbox.create({
      profile: 'strict',
      workspace: testWorkspace,
      limits: { cpuPercent: 10 }
    });

    const startTime = Date.now();
    const result = await sandbox.run(handle.id, 'sh', ['-c', 'for i in {1..1000000}; do echo $i > /dev/null; done']);
    const duration = Date.now() - startTime;

    expect(result.duration).toBeGreaterThan(1000);

    await sandbox.destroy(handle.id);
  });

  it('should enforce memory limit', async () => {
    const handle = await sandbox.create({
      profile: 'strict',
      workspace: testWorkspace,
      limits: { memoryMB: 100 }
    });

    const result = await sandbox.run(handle.id, 'node', ['-e', 'const arr = []; while(true) { arr.push(new Array(1000000).fill("x")); }']);
    
    expect(result.exitCode).not.toBe(0);

    await sandbox.destroy(handle.id);
  });

  it('should enforce process limit', async () => {
    const handle = await sandbox.create({
      profile: 'strict',
      workspace: testWorkspace,
      limits: { processes: 3 }
    });

    const result = await sandbox.run(handle.id, 'sh', ['-c', 'sleep 100 & sleep 100 & sleep 100 & sleep 100 & wait']);
    expect(result.exitCode).not.toBe(0);

    await sandbox.destroy(handle.id);
  });

  it('should cleanup on crash', async () => {
    const handle = await sandbox.create({
      profile: 'strict',
      workspace: testWorkspace
    });

    await sandbox.run(handle.id, 'sh', ['-c', 'kill -9 $$']);
    
    const handles = sandbox.listHandles();
    const destroyedHandle = handles.find(h => h.id === handle.id);
    expect(destroyedHandle?.status).toBe('crashed');

    await sandbox.destroy(handle.id);
  });

  it('should handle multiple concurrent sandboxes', async () => {
    const handles = await Promise.all([
      sandbox.create({ profile: 'strict', workspace: testWorkspace }),
      sandbox.create({ profile: 'strict', workspace: testWorkspace }),
      sandbox.create({ profile: 'strict', workspace: testWorkspace })
    ]);

    const results = await Promise.all(
      handles.map(h => sandbox.run(h.id, 'echo', ['hello']))
    );

    for (const result of results) {
      expect(result.exitCode).toBe(0);
    }

    await Promise.all(handles.map(h => sandbox.destroy(h.id)));
  });
});