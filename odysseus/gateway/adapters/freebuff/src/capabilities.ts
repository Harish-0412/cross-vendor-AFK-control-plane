import type { AgentCapabilities, AgentMetadata } from '@odysseus/protocol';

/**
 * Stated conservatively, because the router and the risk engine trust these.
 * Freebuff is driven through its screen: there is no event stream to read
 * tool calls from and no hook to pause an action for approval.
 */
export const FREEBUFF_CAPABILITIES: AgentCapabilities = {
  sessionCreation: 'supported',
  promptDelivery: 'partial',
  streaming: 'partial',
  cancellation: 'supported',
  diffCollection: 'supported',
  approvalInterception: 'unsupported',
  checkpointRecovery: 'unsupported',
  multiTurn: 'partial',
  fileOperations: 'supported',
  toolExecution: 'supported',
};

export function freebuffMetadata(version = 'unknown'): AgentMetadata {
  return {
    id: 'freebuff',
    name: 'Freebuff',
    version,
    platform: ['linux', 'darwin', 'win32'],
    capabilities: FREEBUFF_CAPABILITIES,
    description:
      'The free Codebuff coding agent. Freebuff has no headless mode, so Odysseus drives its ' +
      'terminal interface: it types the prompt, watches the screen, and treats a screen that ' +
      'has stopped changing as the end of the turn. Actions cannot be paused for approval, ' +
      'and it runs outside the Odysseus sandbox.',
    homepage: 'https://freebuff.com',
    repository: 'https://github.com/CodebuffAI/freebuff',
    license: 'Apache-2.0',
    tags: ['freebuff', 'codebuff', 'cli', 'tui'],
  };
}
