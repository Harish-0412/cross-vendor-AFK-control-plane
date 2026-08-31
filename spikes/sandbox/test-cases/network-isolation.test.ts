import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createSandboxManager } from '../src';

describe('Network Isolation Tests', () => {
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

  it('should block all outbound connections in strict mode', async () => {
    const handle = await sandbox.create({
      profile: 'strict',
      workspace: testWorkspace
    });

    const result = await sandbox.run(handle.id, 'curl', ['-s', '--max-time', '5', 'http://httpbin.org/get']);
    expect(result.exitCode).not.toBe(0);

    await sandbox.destroy(handle.id);
  });

  it('should block inbound connections', async () => {
    const handle = await sandbox.create({
      profile: 'strict',
      workspace: testWorkspace
    });

    const result = await sandbox.run(handle.id, 'nc', ['-l', '8080']);
    expect(result.exitCode).not.toBe(0);

    await sandbox.destroy(handle.id);
  });

  it('should allow localhost in standard mode', async () => {
    const handle = await sandbox.create({
      profile: 'standard',
      workspace: testWorkspace
    });

    const result = await sandbox.run(handle.id, 'curl', ['-s', '--max-time', '2', 'http://localhost:9999']);
    expect(result.exitCode).not.toBe(0);

    await sandbox.destroy(handle.id);
  });

  it('should allow outbound in permissive mode', async () => {
    const handle = await sandbox.create({
      profile: 'permissive',
      workspace: testWorkspace
    });

    const result = await sandbox.run(handle.id, 'curl', ['-s', '--max-time', '5', 'http://httpbin.org/get']);
    expect(result.exitCode).toBe(0);

    await sandbox.destroy(handle.id);
  });

  it('should block DNS resolution in strict mode', async () => {
    const handle = await sandbox.create({
      profile: 'strict',
      workspace: testWorkspace
    });

    const result = await sandbox.run(handle.id, 'nslookup', ['google.com']);
    expect(result.exitCode).not.toBe(0);

    await sandbox.destroy(handle.id);
  });
});