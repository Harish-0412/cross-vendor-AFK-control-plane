import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createSandboxManager } from '../src';

describe('Filesystem Isolation Tests', () => {
  let sandbox: Awaited<ReturnType<typeof createSandboxManager>>;
  const testWorkspace = '/tmp/sandbox-test-workspace';
  const secretFile = '/tmp/secret-should-not-be-accessible.txt';

  beforeAll(async () => {
    sandbox = await createSandboxManager();
    
    await import('fs/promises').then(fs => fs.mkdir(testWorkspace, { recursive: true }));
    await import('fs/promises').then(fs => fs.writeFile(
      path.join(testWorkspace, 'allowed.txt'), 
      'This file should be accessible'
    ));
    await import('fs/promises').then(fs => fs.writeFile(secretFile, 'SECRET_DATA'));
  });

  afterAll(async () => {
    await sandbox.shutdown();
    await import('fs/promises').then(fs => fs.rm(testWorkspace, { recursive: true, force: true }));
    await import('fs/promises').then(fs => fs.unlink(secretFile).catch(() => {}));
  });

  const path = await import('path');

  it('should allow reading files within workspace', async () => {
    const handle = await sandbox.create({
      profile: 'strict',
      workspace: testWorkspace
    });

    const result = await sandbox.run(handle.id, 'cat', ['allowed.txt']);
    
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain('This file should be accessible');
    
    await sandbox.destroy(handle.id);
  });

  it('should deny reading files outside workspace', async () => {
    const handle = await sandbox.create({
      profile: 'strict',
      workspace: testWorkspace
    });

    const result = await sandbox.run(handle.id, 'cat', [secretFile]);
    
    expect(result.exitCode).not.toBe(0);
    expect(result.stdout).not.toContain('SECRET_DATA');
    
    await sandbox.destroy(handle.id);
  });

  it('should deny reading ~/.ssh', async () => {
    const handle = await sandbox.create({
      profile: 'strict',
      workspace: testWorkspace
    });

    const result = await sandbox.run(handle.id, 'cat', [path.join(process.env.HOME || '/home/user', '.ssh', 'id_rsa')]);
    
    expect(result.exitCode).not.toBe(0);
    
    await sandbox.destroy(handle.id);
  });

  it('should deny reading ~/.aws', async () => {
    const handle = await sandbox.create({
      profile: 'strict',
      workspace: testWorkspace
    });

    const result = await sandbox.run(handle.id, 'cat', [path.join(process.env.HOME || '/home/user', '.aws', 'credentials')]);
    
    expect(result.exitCode).not.toBe(0);
    
    await sandbox.destroy(handle.id);
  });

  it('should allow writing within workspace', async () => {
    const handle = await sandbox.create({
      profile: 'strict',
      workspace: testWorkspace
    });

    const result = await sandbox.run(handle.id, 'sh', ['-c', 'echo "new file" > new-file.txt']);
    
    expect(result.exitCode).toBe(0);
    
    const verify = await sandbox.run(handle.id, 'cat', ['new-file.txt']);
    expect(verify.stdout).toContain('new file');
    
    await sandbox.destroy(handle.id);
  });

  it('should deny writing outside workspace', async () => {
    const handle = await sandbox.create({
      profile: 'strict',
      workspace: testWorkspace
    });

    const result = await sandbox.run(handle.id, 'sh', ['-c', `echo "hack" > /tmp/outside.txt`]);
    
    expect(result.exitCode).not.toBe(0);
    
    await sandbox.destroy(handle.id);
  });

  it('should prevent directory traversal', async () => {
    const handle = await sandbox.create({
      profile: 'strict',
      workspace: testWorkspace
    });

    const result = await sandbox.run(handle.id, 'cat', ['../../etc/passwd']);
    
    expect(result.exitCode).not.toBe(0);
    
    await sandbox.destroy(handle.id);
  });
});