import { PlatformSandbox, SandboxConfig, SandboxHandle, SandboxResult, SandboxCapabilities } from './types';
import { PLATFORM, getProfile, resolvePaths } from './profiles';
import * as fs from 'fs/promises';
import * as path from 'path';
import { v4 as uuidv4 } from 'uuid';

interface MacOSSandboxHandle extends SandboxHandle {
  profilePath: string;
}

export class MacOSSandbox implements PlatformSandbox {
  readonly platform: 'darwin' = 'darwin';
  private handles: Map<string, MacOSSandboxHandle> = new Map();
  private profileDir = '/tmp/freebuff-sandbox-profiles';

  async isSupported(): Promise<boolean> {
    if (PLATFORM !== 'darwin') return false;
    
    try {
      const { spawn } = await import('child_process');
      return new Promise((resolve) => {
        const child = spawn('sandbox-exec', ['-h']);
        child.on('close', (code) => resolve(code === 0));
        child.on('error', () => resolve(false));
      });
    } catch {
      return false;
    }
  }

  getCapabilities(): SandboxCapabilities {
    return {
      filesystemIsolation: true,
      processIsolation: true,
      networkIsolation: false,
      cpuLimits: false,
      memoryLimits: false,
      diskLimits: false,
      rootless: true
    };
  }

  async create(config: SandboxConfig): Promise<SandboxHandle> {
    const id = `sbx_${uuidv4().replace(/-/g, '').slice(0, 12)}`;
    const profile = getProfile(config.profile);
    const home = process.env.HOME || '/Users/user';
    const resolvedFs = resolvePaths(profile.filesystem, config.workspace, home);

    await fs.mkdir(this.profileDir, { recursive: true });
    const profilePath = path.join(this.profileDir, `${id}.sb`);
    
    const seatbeltProfile = this.generateSeatbeltProfile(resolvedFs, profile);
    await fs.writeFile(profilePath, seatbeltProfile);

    const handle: MacOSSandboxHandle = {
      id,
      pid: 0,
      config,
      status: 'creating',
      createdAt: new Date(),
      platform: 'darwin',
      profilePath
    };

    this.handles.set(id, handle);
    return handle;
  }

  private generateSeatbeltProfile(fsRules: FilesystemRules, profile: any): string {
    const lines = ['(version 1)', '(deny default)'];

    for (const readPath of fsRules.readPaths) {
      lines.push(`(allow file-read* (literal "${readPath}"))`);
      if (fsRules.followSymlinks) {
        lines.push(`(allow file-read* (regex #"^${readPath.replace(/\//g, '\\/')}.*"))`);
      }
    }

    for (const writePath of fsRules.writePaths) {
      lines.push(`(allow file-write* (literal "${writePath}"))`);
      lines.push(`(allow file-write* (regex #"^${writePath.replace(/\//g, '\\/')}.*"))`);
    }

    for (const denyPath of fsRules.denyPaths) {
      lines.push(`(deny file-read* (regex #"^${denyPath.replace(/\//g, '\\/')}.*"))`);
      lines.push(`(deny file-write* (regex #"^${denyPath.replace(/\//g, '\\/')}.*"))`);
    }

    if (fsRules.allowTmp) {
      lines.push('(allow file-read* (literal "/tmp"))');
      lines.push('(allow file-write* (literal "/tmp"))');
    }

    for (const allow of profile.process.allowList) {
      lines.push(`(allow process-exec (literal "${allow}"))`);
      lines.push(`(allow process-exec (regex #"^/usr/bin/${allow}$"))`);
      lines.push(`(allow process-exec (regex #"^/opt/homebrew/bin/${allow}$"))`);
    }

    for (const deny of profile.process.denyList) {
      lines.push(`(deny process-exec (literal "${deny}"))`);
    }

    if (profile.network.mode === 'none') {
      lines.push('(deny network-outbound)');
      lines.push('(deny network-inbound)');
    } else if (profile.network.mode === 'localhost') {
      lines.push('(allow network-outbound (destination 127.0.0.1))');
      lines.push('(allow network-outbound (destination ::1))');
      lines.push('(deny network-outbound)');
      lines.push('(deny network-inbound)');
    } else if (profile.network.mode === 'outbound') {
      lines.push('(allow network-outbound)');
      lines.push('(deny network-inbound)');
    }

    return lines.join('\n');
  }

  async run(handle: SandboxHandle, command: string, args: string[]): Promise<SandboxResult> {
    const macHandle = handle as MacOSSandboxHandle;
    const startTime = Date.now();

    const fullCommand = [command, ...args].join(' ');
    
    const { spawn } = await import('child_process');
    
    return new Promise((resolve, reject) => {
      const child = spawn('sandbox-exec', ['-f', macHandle.profilePath, '--', '/bin/sh', '-c', fullCommand], {
        cwd: handle.config.workspace,
        env: { ...process.env, ...handle.config.env },
        stdio: ['pipe', 'pipe', 'pipe']
      });

      macHandle.pid = child.pid || 0;
      macHandle.status = 'running';

      let stdout = '';
      let stderr = '';

      child.stdout?.on('data', (data) => { stdout += data.toString(); });
      child.stderr?.on('data', (data) => { stderr += data.toString(); });

      child.on('close', (code, signal) => {
        macHandle.status = signal ? 'crashed' : (code === 0 ? 'stopped' : 'crashed');
        resolve({
          exitCode: code,
          signal,
          stdout,
          stderr,
          duration: Date.now() - startTime
        });
      });

      child.on('error', (err) => {
        macHandle.status = 'crashed';
        reject(err);
      });
    });
  }

  async destroy(handle: SandboxHandle): Promise<void> {
    const macHandle = handle as MacOSSandboxHandle;
    
    try {
      await fs.unlink(macHandle.profilePath);
    } catch {
    }

    this.handles.delete(handle.id);
  }

  getHandle(id: string): SandboxHandle | undefined {
    return this.handles.get(id);
  }

  listHandles(): SandboxHandle[] {
    return Array.from(this.handles.values());
  }
}

export async function createMacOSSandbox(): Promise<MacOSSandbox | null> {
  const sandbox = new MacOSSandbox();
  const supported = await sandbox.isSupported();
  return supported ? sandbox : null;
}