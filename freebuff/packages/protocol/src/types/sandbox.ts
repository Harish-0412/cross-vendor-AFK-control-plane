import type { Platform } from './agent';
import type { ResourceLimits } from './session';

export type SandboxState = 'creating' | 'running' | 'paused' | 'stopped' | 'destroyed' | 'error';

export type SandboxProfile = 'strict' | 'standard' | 'permissive';

export type NetworkPolicyMode = 'deny-all' | 'allow-list' | 'allow-all';

export interface NetworkPolicy {
  mode: NetworkPolicyMode;
  allowedDomains?: string[];
  allowedPorts?: number[];
  allowedHosts?: string[];
  denyLocalhost?: boolean;
}

export interface SandboxConfig {
  projectRoot: string;
  agentBinary: string;
  agentArgs: string[];
  env: Record<string, string>;
  resourceLimits: ResourceLimits;
  networkPolicy: NetworkPolicy;
  writablePaths: string[];
  readablePaths: string[];
  deniedPaths: string[];
  profile: SandboxProfile;
  labels?: Record<string, string>;
}

export interface SandboxStatus {
  id: string;
  state: SandboxState;
  pid: number;
  projectRoot: string;
  createdAt: Date;
  startedAt?: Date;
  stoppedAt?: Date;
  destroyedAt?: Date;
  uptimeMs?: number;
  exitCode?: number;
  signal?: string;
  error?: string;
}

export interface SandboxResourceUsage {
  cpuPercent: number;
  memoryMb: number;
  memoryPeakMb: number;
  activeProcesses: number;
  peakProcesses: number;
  openFiles: number;
  networkBytesSent: number;
  networkBytesReceived: number;
  diskReadBytes: number;
  diskWriteBytes: number;
  measuredAt: Date;
}

export interface SandboxCapabilities {
  filesystemIsolation: boolean;
  processIsolation: boolean;
  networkIsolation: boolean;
  cpuLimits: boolean;
  memoryLimits: boolean;
  diskLimits: boolean;
  processLimits: boolean;
  rootless: boolean;
  checkpointRestore: boolean;
}

export interface Sandbox {
  readonly id: string;
  readonly state: SandboxState;
  readonly pid: number;
  readonly projectRoot: string;
  readonly createdAt: Date;

  start(): Promise<void>;
  stop(timeoutMs?: number): Promise<number | null>;
  kill(signal?: string): Promise<void>;
  pause(): Promise<void>;
  resume(): Promise<void>;
  destroy(): Promise<void>;

  stdin: NodeJS.WritableStream;
  stdout: NodeJS.ReadableStream;
  stderr: NodeJS.ReadableStream;

  getStatus(): Promise<SandboxStatus>;
  getResourceUsage(): Promise<SandboxResourceUsage>;
  isAlive(): Promise<boolean>;
  waitForExit(): Promise<{ exitCode: number | null; signal: string | null }>;
}

export interface SandboxManager {
  create(config: SandboxConfig): Promise<Sandbox>;
  destroy(sandboxId: string): Promise<void>;
  get(sandboxId: string): Sandbox | undefined;
  list(): Sandbox[];
  getStatus(sandboxId: string): Promise<SandboxStatus>;
  listByState(state: SandboxState): Sandbox[];
  getCapabilities(): SandboxCapabilities;
  getPlatform(): Platform;
  isSupported(): Promise<boolean>;
  cleanupOrphans(): Promise<number>;
  shutdown(timeoutMs?: number): Promise<void>;
}

export interface SandboxCreationResult {
  success: boolean;
  sandbox?: Sandbox;
  error?: {
    code: string;
    message: string;
    retryable: boolean;
  };
}

export interface SandboxCleanupReport {
  destroyed: number;
  failed: Array<{ sandboxId: string; error: string }>;
  durationMs: number;
}

export const SANDBOX_ID_PREFIX = 'sbx_';
export const SANDBOX_ID_LENGTH = 24;

export const DEFAULT_SANDBOX_TIMEOUT_MS = 5000;
export const DEFAULT_FORCE_KILL_DELAY_MS = 2000;

export const SANDBOX_PROFILE_DEFAULTS: Record<SandboxProfile, {
  resourceLimits: ResourceLimits;
  networkMode: NetworkPolicyMode;
}> = {
  strict: {
    resourceLimits: {
      cpuPercent: 50,
      memoryMb: 2048,
      maxProcesses: 10,
      maxOpenFiles: 256,
    },
    networkMode: 'deny-all',
  },
  standard: {
    resourceLimits: {
      cpuPercent: 75,
      memoryMb: 4096,
      maxProcesses: 20,
      maxOpenFiles: 512,
    },
    networkMode: 'allow-list',
  },
  permissive: {
    resourceLimits: {
      cpuPercent: 100,
      memoryMb: 8192,
      maxProcesses: 50,
      maxOpenFiles: 1024,
    },
    networkMode: 'allow-all',
  },
};

export function isValidSandboxId(id: string): boolean {
  return id.startsWith(SANDBOX_ID_PREFIX) && id.length === SANDBOX_ID_PREFIX.length + SANDBOX_ID_LENGTH;
}

export function isTerminalSandboxState(state: SandboxState): boolean {
  return state === 'stopped' || state === 'destroyed' || state === 'error';
}
