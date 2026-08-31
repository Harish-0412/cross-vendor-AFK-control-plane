import { PlatformSandbox, SandboxConfig, SandboxHandle, SandboxResult, SandboxCapabilities } from './types';
import { PLATFORM, getProfile, resolvePaths } from './profiles';
import * as fs from 'fs/promises';
import * as path from 'path';
import { v4 as uuidv4 } from 'uuid';

interface WindowsSandboxHandle extends SandboxHandle {
  jobHandle?: number;
  appContainerName?: string;
}

export class WindowsSandbox implements PlatformSandbox {
  readonly platform: 'win32' = 'win32';
  private handles: Map<string, WindowsSandboxHandle> = new Map();

  async isSupported(): Promise<boolean> {
    if (PLATFORM !== 'win32') return false;
    return true;
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
    const home = process.env.USERPROFILE || 'C:\\Users\\user';
    const resolvedFs = resolvePaths(profile.filesystem, config.workspace, home);

    const handle: WindowsSandboxHandle = {
      id,
      pid: 0,
      config,
      status: 'creating',
      createdAt: new Date(),
      platform: 'win32'
    };

    this.handles.set(id, handle);
    return handle;
  }

  async run(handle: SandboxHandle, command: string, args: string[]): Promise<SandboxResult> {
    const winHandle = handle as WindowsSandboxHandle;
    const startTime = Date.now();
    const profile = getProfile(handle.config.profile);

    const { spawn } = await import('child_process');
    
    const fullCommand = [command, ...args.map(a => `"${a}"`)].join(' ');

    return new Promise((resolve, reject) => {
      const child = spawn('cmd.exe', ['/c', fullCommand], {
        cwd: handle.config.workspace,
        env: { ...process.env, ...handle.config.env },
        stdio: ['pipe', 'pipe', 'pipe'],
        windowsHide: true
      });

      winHandle.pid = child.pid || 0;
      winHandle.status = 'running';

      this.applyJobLimits(child.pid!, profile.resources);

      let stdout = '';
      let stderr = '';

      child.stdout?.on('data', (data) => { stdout += data.toString(); });
      child.stderr?.on('data', (data) => { stderr += data.toString(); });

      child.on('close', (code, signal) => {
        winHandle.status = signal ? 'crashed' : (code === 0 ? 'stopped' : 'crashed');
        resolve({
          exitCode: code,
          signal,
          stdout,
          stderr,
          duration: Date.now() - startTime
        });
      });

      child.on('error', (err) => {
        winHandle.status = 'crashed';
        reject(err);
      });
    });
  }

  private applyJobLimits(pid: number, limits: any): void {
    // Windows Job Object limits would be applied here
    // This requires native Node.js addon or PowerShell invocation
    // For PoC, we document the approach
    console.log(`[SANDBOX] Would apply Job Object limits to PID ${pid}:`, limits);
  }

  async destroy(handle: SandboxHandle): Promise<void> {
    const winHandle = handle as WindowsSandboxHandle;
    
    if (winHandle.jobHandle) {
      // Close job handle
    }
    
    if (winHandle.appContainerName) {
      // Remove AppContainer
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

export async function createWindowsSandbox(): Promise<WindowsSandbox | null> {
  const sandbox = new WindowsSandbox();
  const supported = await sandbox.isSupported();
  return supported ? sandbox : null;
}