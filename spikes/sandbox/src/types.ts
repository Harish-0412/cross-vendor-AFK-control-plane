export interface SandboxConfig {
  profile: 'strict' | 'standard' | 'permissive';
  workspace: string;
  limits?: ResourceLimits;
  network?: NetworkConfig;
  env?: Record<string, string>;
}

export interface ResourceLimits {
  cpuPercent?: number;      // 1-100
  memoryMB?: number;        // MB
  diskMB?: number;          // MB
  processes?: number;       // Max child processes
  openFiles?: number;       // Max file descriptors
}

export interface NetworkConfig {
  mode: 'none' | 'localhost' | 'outbound' | 'full';
  allowedPorts?: number[];
  allowedHosts?: string[];
}

export interface SandboxHandle {
  id: string;
  pid: number;
  config: SandboxConfig;
  status: 'creating' | 'running' | 'stopped' | 'crashed';
  createdAt: Date;
  platform: Platform;
}

export interface SandboxResult {
  exitCode: number | null;
  signal: string | null;
  stdout: string;
  stderr: string;
  duration: number;
  resourceUsage?: ResourceUsage;
}

export interface ResourceUsage {
  cpuTimeMs: number;
  maxMemoryMB: number;
  peakProcesses: number;
  networkBytesSent: number;
  networkBytesReceived: number;
}

export type Platform = 'linux' | 'darwin' | 'win32';

export interface SandboxProfile {
  name: string;
  description: string;
  filesystem: FilesystemRules;
  process: ProcessRules;
  network: NetworkRules;
  resources: ResourceLimits;
}

export interface FilesystemRules {
  readPaths: string[];      // Allowed read paths (supports globs)
  writePaths: string[];     // Allowed write paths
  denyPaths: string[];      // Explicitly denied paths (high priority)
  followSymlinks: boolean;
  allowTmp: boolean;
}

export interface ProcessRules {
  allowList: string[];      // Allowed executables (basename or path)
  denyList: string[];       // Denied executables
  allowShell: boolean;      // Allow shell builtins
  maxProcesses: number;
}

export interface NetworkRules {
  mode: 'none' | 'localhost' | 'outbound' | 'full';
  allowedPorts: number[];
  allowedHosts: string[];
  denyLocalhost: boolean;
}

export interface SandboxManager {
  create(config: SandboxConfig): Promise<SandboxHandle>;
  run(handleId: string, command: string, args: string[]): Promise<SandboxResult>;
  destroy(handleId: string): Promise<void>;
  getHandle(handleId: string): SandboxHandle | undefined;
  listHandles(): SandboxHandle[];
  getPlatform(): Platform;
}

export interface PlatformSandbox {
  readonly platform: Platform;
  create(config: SandboxConfig): Promise<SandboxHandle>;
  run(handle: SandboxHandle, command: string, args: string[]): Promise<SandboxResult>;
  destroy(handle: SandboxHandle): Promise<void>;
  isSupported(): boolean;
  getCapabilities(): SandboxCapabilities;
}

export interface SandboxCapabilities {
  filesystemIsolation: boolean;
  processIsolation: boolean;
  networkIsolation: boolean;
  cpuLimits: boolean;
  memoryLimits: boolean;
  diskLimits: boolean;
  rootless: boolean;
}