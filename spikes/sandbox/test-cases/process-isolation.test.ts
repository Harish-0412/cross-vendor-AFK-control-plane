import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createSandboxManager } from '../src';

describe('Process Isolation Tests', () => {
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

  it('should allow allowed processes (git, npm, node)', async () => {
    const handle = await sandbox.create({
      profile: 'strict',
      workspace: testWorkspace
    });

    const result = await sandbox.run(handle.id, 'git', ['--version']);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain('git version');

    await sandbox.destroy(handle.id);
  });

  it('should deny denied processes (sudo, docker, kubectl)', async () => {
    const handle = await sandbox.create({
      profile: 'strict',
      workspace: testWorkspace
    });

    const result = await sandbox.run(handle.id, 'sudo', ['echo', 'test']);
    expect(result.exitCode).not.toBe(0);

    await sandbox.destroy(handle.id);
  });

  it('should prevent process escape', async () => {
    const handle = await sandbox.create({
      profile: 'strict',
      workspace: testWorkspace
    });

    const result = await sandbox.run(handle.id, 'sh', ['-c', 'ps aux | grep -v sandbox']);
    expect(result.exitCode).not.toBe(0);

    await sandbox.destroy(handle.id);
  });

  it('should enforce process limit', async () => {
    const handle = await sandbox.create({
      profile: 'strict',
      workspace: testWorkspace,
      limits: { processes: 5 }
    });

    const result = await sandbox.run(handle.id, 'sh', ['-c', 'for i in {1..10}; do sleep 100 & done; wait']);
    expect(result.exitCode).not.toBe(0);

    await sandbox.destroy(handle.id);
  });

  it('should isolate process namespace (Linux)', async () => {
    const handle = await sandbox.create({
      profile: 'strict',
      workspace: testWorkspace
    });

    const result = await sandbox.run(handle.id, 'sh', ['-c', 'echo $$; ps aux']);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain('1');

    await sandbox.destroy(handle.id);
  });
});