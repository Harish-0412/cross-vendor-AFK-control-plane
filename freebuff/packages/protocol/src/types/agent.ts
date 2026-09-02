export type CapabilityLevel = 'supported' | 'partial' | 'unsupported';

export interface AgentCapabilities {
  sessionCreation: CapabilityLevel;
  promptDelivery: CapabilityLevel;
  streaming: CapabilityLevel;
  cancellation: CapabilityLevel;
  diffCollection: CapabilityLevel;
  approvalInterception: CapabilityLevel;
  checkpointRecovery: CapabilityLevel;
  multiTurn: CapabilityLevel;
  fileOperations: CapabilityLevel;
  toolExecution: CapabilityLevel;
}

export type Platform = 'linux' | 'darwin' | 'win32';

export interface AgentMetadata {
  id: string;
  name: string;
  version: string;
  platform: Platform[];
  capabilities: AgentCapabilities;
  description?: string;
  homepage?: string;
  repository?: string;
  license?: string;
  tags?: string[];
}

export interface AgentInfo {
  metadata: AgentMetadata;
  installed: boolean;
  installPath?: string | undefined;
  detectedVersion?: string | undefined;
  health: AgentHealth;
  lastDetectedAt: Date;
}

export interface AgentHealth {
  status: 'healthy' | 'degraded' | 'unhealthy' | 'unknown';
  lastCheckAt: Date;
  issues?: string[];
  checks?: Record<string, 'pass' | 'fail' | 'skip'>;
}

export interface AgentInstallationResult {
  success: boolean;
  installedVersion?: string;
  path?: string;
  warnings?: string[];
  error?: {
    code: string;
    message: string;
    retryable: boolean;
  };
}

export interface AgentValidationResult {
  valid: boolean;
  errors: string[];
  warnings: string[];
  checks: Record<string, boolean>;
}

export const ALL_PLATFORMS: Platform[] = ['linux', 'darwin', 'win32'];

export function isPlatformSupported(metadata: AgentMetadata, platform: Platform): boolean {
  return metadata.platform.includes(platform);
}

export function getCapabilitySummary(capabilities: AgentCapabilities): {
  supported: number;
  partial: number;
  unsupported: number;
  total: number;
} {
  const entries = Object.values(capabilities);
  return {
    supported: entries.filter((c) => c === 'supported').length,
    partial: entries.filter((c) => c === 'partial').length,
    unsupported: entries.filter((c) => c === 'unsupported').length,
    total: entries.length,
  };
}

export function hasMinimumViableCapabilities(capabilities: AgentCapabilities): boolean {
  return (
    capabilities.sessionCreation === 'supported' &&
    capabilities.promptDelivery === 'supported' &&
    capabilities.streaming !== 'unsupported' &&
    capabilities.cancellation !== 'unsupported'
  );
}

export function createDefaultAgentHealth(): AgentHealth {
  return {
    status: 'unknown',
    lastCheckAt: new Date(0),
  };
}
