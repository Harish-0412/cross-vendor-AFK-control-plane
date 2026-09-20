import type { AgentMetadata } from '@odysseus/protocol';

/**
 * What this adapter can actually do.
 *
 * These are enforced: `GatewayImpl.createSession` rejects a session whose
 * configuration needs something declared `unsupported`, before any process
 * starts. Overstating a capability here does not make the feature work — it
 * makes the system lie about it, which is worse than refusing the session.
 *
 * `approvalInterception` is the one to read carefully. Claude Code can gate
 * tool calls interactively, but only when the caller supplies a
 * `--permission-prompt-tool` MCP host for it to ask. This adapter does not
 * provide one, so per-call human approval is genuinely unavailable and is
 * declared `unsupported`. What the adapter does enforce is policy: it runs
 * with `--permission-mode dontAsk` (or `auto`) plus `--permission-prompts
 * none`, so anything that would have prompted is denied rather than silently
 * allowed, and each denial is reported as a `policy.violation` event.
 */
export function claudeCodeMetadata(version = 'unknown'): AgentMetadata {
  return {
    id: 'claude-code',
    name: 'Claude Code',
    version,
    platform: ['linux', 'darwin', 'win32'],
    capabilities: {
      sessionCreation: 'supported',
      // Follow-up prompts resume the same conversation via --resume.
      promptDelivery: 'supported',
      // stream-json emits events as the turn progresses.
      streaming: 'supported',
      // SIGINT ends the turn and still records a result.
      cancellation: 'supported',
      // Collected from git in the project root, so untracked files are seen
      // but a non-git project yields nothing.
      diffCollection: 'partial',
      // No --permission-prompt-tool host: policy is enforced, but a human
      // cannot approve an individual call mid-run.
      approvalInterception: 'unsupported',
      // --resume restores the conversation, but not a turn interrupted midway.
      checkpointRecovery: 'partial',
      multiTurn: 'supported',
      fileOperations: 'supported',
      toolExecution: 'supported',
    },
    description:
      "Anthropic's Claude Code CLI driven in headless mode (-p with " +
      'stream-json output), with policy enforced through permission modes.',
    homepage: 'https://code.claude.com',
    tags: ['anthropic', 'claude', 'cli', 'headless'],
  };
}
