import { PlatformSandbox, SandboxConfig, SandboxHandle, SandboxResult, SandboxCapabilities } from './types';
import { PLATFORM, getProfile, resolvePaths } from './profiles';
import * as fs from 'fs/promises';
import * as path from 'path';
import { v4 as uuidv4 } from 'uuid';

interface LinuxSandboxHandle extends SandboxHandle {
  cgroupPath: string;
  namespacePid: number;
  mountProc: boolean;
}

export class LinuxSandbox implements PlatformSandbox {
  readonly platform: 'linux' = 'linux';
  private handles: Map<string, LinuxSandboxHandle> = new Map();
  private cgroupBase = '/sys/fs/cgroup/freebuff';

  async isSupported(): Promise<boolean> {
    if (PLATFORM !== 'linux') return false;
    
    try {
      await fs.access('/proc/self/ns/pid');
      await fs.access('/sys/fs/cgroup');
      return true;
    } catch {
      return false;
    }
  }

  getCapabilities(): SandboxCapabilities {
    return {
      filesystemIsolation: true,
      processIsolation: true,
      networkIsolation: true,
      cpuLimits: true,
      memoryLimits: true,
      diskLimits: false,
      rootless: true
    };
  }

  async create(config: SandboxConfig): Promise<SandboxHandle> {
    const id = `sbx_${uuidv4().replace(/-/g, '').slice(0, 12)}`;
    const profile = getProfile(config.profile);
    const home = process.env.HOME || '/home/user';
    const resolvedFs = resolvePaths(profile.filesystem, config.workspace, home);

    const cgroupPath = path.join(this.cgroupBase, id);
    
    try {
      await this.setupCgroup(cgroupPath, profile.resources);
    } catch (error) {
      console.warn('Cgroup setup failed, continuing without resource limits:', error);
    }

    const handle: LinuxSandboxHandle = {
      id,
      pid: 0,
      config,
      status: 'creating',
      createdAt: new Date(),
      platform: 'linux',
      cgroupPath,
      namespacePid: 0,
      mountProc: false
    };

    this.handles.set(id, handle);
    return handle;
  }

  private async setupCgroup(cgroupPath: string, limits: ResourceLimits): Promise<void> {
    await fs.mkdir(cgroupPath, { recursive: true });

    if (limits.cpuPercent) {
      const quota = Math.round(limits.cpuPercent * 1000);
      await fs.writeFile(path.join(cgroupPath, 'cpu.max'), `${quota} 100000`);
    }

    if (limits.memoryMB) {
      const bytes = limits.memoryMB * 1024 * 1024;
      await fs.writeFile(path.join(cgroupPath, 'memory.max'), bytes.toString());
    }

    if (limits.processes) {
      await fs.writeFile(path.join(cgroupPath, 'pids.max'), limits.processes.toString());
    }

    if (limits.openFiles) {
      await fs.writeFile(path.join(cgroupPath, 'io.max'), `rbps=${limits.openFiles} wbps=${limits.openFiles}`);
    }
  }

  async run(handle: SandboxHandle, command: string, args: string[]): Promise<SandboxResult> {
    const linuxHandle = handle as LinuxSandboxHandle;
    const profile = getProfile(handle.config.profile);
    const home = process.env.HOME || '/home/user';
    const resolvedFs = resolvePaths(profile.filesystem, handle.config.workspace, home);

    const startTime = Date.now();
    
    const unshareArgs = this.buildUnshareArgs(linuxHandle, resolvedFs, profile);
    const fullArgs = [...unshareArgs, command, ...args];

    const { spawn } = await import('child_process');
    
    return new Promise((resolve, reject) => {
      const child = spawn('unshare', fullArgs, {
        cwd: handle.config.workspace,
        env: this.buildEnv(handle.config.env, resolvedFs),
        stdio: ['pipe', 'pipe', 'pipe']
      });

      linuxHandle.pid = child.pid || 0;
      linuxHandle.status = 'running';
      linuxHandle.namespacePid = child.pid || 0;

      this.addToCgroup(linuxHandle.cgroupPath, child.pid!);

      let stdout = '';
      let stderr = '';

      child.stdout?.on('data', (data) => { stdout += data.toString(); });
      child.stderr?.on('data', (data) => { stderr += data.toString(); });

      child.on('close', (code, signal) => {
        linuxHandle.status = signal ? 'crashed' : (code === 0 ? 'stopped' : 'crashed');
        resolve({
          exitCode: code,
          signal,
          stdout,
          stderr,
          duration: Date.now() - startTime
        });
      });

      child.on('error', (err) => {
        linuxHandle.status = 'crashed';
        reject(err);
      });
    });
  }

  private buildUnshareArgs(handle: LinuxSandboxHandle, fsRules: FilesystemRules, profile: any): string[] {
    const args = ['--pid', '--mount', '--net', '--user', '--map-root-user', '--fork'];

    if (fsRules.denyPaths.length > 0) {
      for (const denyPath of fsRules.denyPaths) {
        args.push('--mount-proc');
        break;
      }
    }

    return args;
  }

  private buildEnv(customEnv: Record<string, string> | undefined, fsRules: FilesystemRules): Record<string, string> {
    const env = { ...process.env };
    
    if (customEnv) {
      Object.assign(env, customEnv);
    }

    env.SANDBOX_WORKSPACE = fsRules.readPaths[0] || process.cwd();
    env.SANDBOX_PROFILE = 'strict';

    if (fsRules.denyPaths.length > 0) {
      env.SANDBOX_DENY_PATHS = fsRules.denyPaths.join(':');
    }

    return env;
  }

  private async addToCgroup(cgroupPath: string, pid: number): Promise<void> {
    try {
      await fs.writeFile(path.join(cgroupPath, 'cgroup.procs'), pid.toString());
    } catch (error) {
      console.warn('Failed to add process to cgroup:', error);
    }
  }

  async destroy(handle: SandboxHandle): Promise<void> {
    const linuxHandle = handle as LinuxSandboxHandle;
    
    try {
      await fs.rm(linuxHandle.cgroupPath, { recursive: true, force: true });
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

export async function createLinuxSandbox(): Promise<LinuxSandbox | null> {
  const sandbox = new LinuxSandbox();
  const supported = await sandbox.isSupported();
  return supported ? sandbox : null;
}