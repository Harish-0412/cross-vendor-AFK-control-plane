import type { AgentCapabilities, AgentMetadata } from '@freebuff/protocol';

export const OPENCODE_CAPABILITIES: AgentCapabilities = {
  sessionCreation: 'supported',
  promptDelivery: 'partial',
  streaming: 'supported',
  cancellation: 'supported',
  diffCollection: 'supported',
  approvalInterception: 'unsupported',
  checkpointRecovery: 'partial',
  multiTurn: 'partial',
  fileOperations: 'supported',
  toolExecution: 'supported',
};

export function opencodeMetadata(version = 'unknown'): AgentMetadata {
  return {
    id: 'opencode', name: 'OpenCode', version, platform: ['linux', 'darwin', 'win32'],
    capabilities: OPENCODE_CAPABILITIES,
    description: 'OpenCode CLI adapter. Native external approval interception is not available, so high-risk actions cannot be paused mid-execution.',
    homepage: 'https://opencode.ai', repository: 'https://github.com/anomalyco/opencode', license: 'MIT',
    tags: ['opencode', 'cli', 'production'],
  };
}
