import { PlatformSandbox, SandboxConfig, SandboxHandle, SandboxResult, Platform } from './types';
import { LinuxSandbox, createLinuxSandbox } from './linux-sandbox';
import { MacOSSandbox, createMacOSSandbox } from './macos-sandbox';
import { WindowsSandbox, createWindowsSandbox } from './windows-sandbox';
import { PLATFORM } from './profiles';

export class SandboxManager {
  private sandbox: PlatformSandbox | null = null;
  private handles: Map<string, SandboxHandle> = new Map();

  async initialize(): Promise<void> {
    switch (PLATFORM) {
      case 'linux':
        this.sandbox = await createLinuxSandbox();
        break;
      case 'darwin':
        this.sandbox = await createMacOSSandbox();
        break;
      case 'win32':
        this.sandbox = await createWindowsSandbox();
        break;
    }

    if (!this.sandbox) {
      throw new Error(`Sandbox not supported on platform: ${PLATFORM}`);
    }

    console.log(`[SANDBOX] Initialized ${this.sandbox.platform} sandbox`);
  }

  getPlatform(): Platform {
    return PLATFORM;
  }

  getCapabilities() {
    return this.sandbox?.getCapabilities() || {
      filesystemIsolation: false,
      processIsolation: false,
      networkIsolation: false,
      cpuLimits: false,
      memoryLimits: false,
      diskLimits: false,
      rootless: false
    };
  }

  async create(config: SandboxConfig): Promise<SandboxHandle> {
    if (!this.sandbox) {
      await this.initialize();
    }
    const handle = await this.sandbox!.create(config);
    this.handles.set(handle.id, handle);
    return handle;
  }

  async run(handleId: string, command: string, args: string[]): Promise<SandboxResult> {
    const handle = this.handles.get(handleId);
    if (!handle) {
      throw new Error(`Sandbox handle not found: ${handleId}`);
    }
    return this.sandbox!.run(handle, command, args);
  }

  async destroy(handleId: string): Promise<void> {
    const handle = this.handles.get(handleId);
    if (!handle) {
      throw new Error(`Sandbox handle not found: ${handleId}`);
    }
    await this.sandbox!.destroy(handle);
    this.handles.delete(handleId);
  }

  getHandle(handleId: string): SandboxHandle | undefined {
    return this.handles.get(handleId);
  }

  listHandles(): SandboxHandle[] {
    return Array.from(this.handles.values());
  }

  async shutdown(): Promise<void> {
    for (const handle of this.handles.values()) {
      try {
        await this.destroy(handle.id);
      } catch (error) {
        console.warn(`Failed to destroy sandbox ${handle.id}:`, error);
      }
    }
    this.handles.clear();
  }
}

export async function createSandboxManager(): Promise<SandboxManager> {
  const manager = new SandboxManager();
  await manager.initialize();
  return manager;
}