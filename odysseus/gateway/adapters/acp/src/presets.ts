/**
 * Agents Odysseus knows how to start over ACP. Each needs its ACP entry point
 * installed and on PATH; the first command found is used.
 *
 * Over ACP the agent asks before each tool call it wants approved, so these
 * are the agents whose individual actions Odysseus can approve or deny —
 * including Claude Code, whose headless mode cannot be intercepted.
 */
export interface AcpAgentPreset {
  id: string;
  name: string;
  /** Candidates, tried in order: a bridge's new name, then its old one. */
  commands: Array<{ command: string; args?: string[] }>;
  /** Shown when none of the commands is installed. */
  installHint: string;
  description: string;
  homepage?: string;
  tags: string[];
  /**
   * Extra environment that makes the agent ask before acting. Some agents
   * only ask when their own settings say so; without this Odysseus would
   * have nothing to approve.
   */
  askEnvironment?: (env: NodeJS.ProcessEnv) => Record<string, string>;
}

/**
 * OpenCode runs commands and edits without asking by default. Inline config
 * (OPENCODE_CONFIG_CONTENT) turns that into "ask", merged over any inline
 * config the person already uses.
 */
function openCodeAsks(env: NodeJS.ProcessEnv): Record<string, string> {
  let existing: Record<string, unknown> = {};
  try {
    existing = JSON.parse(env['OPENCODE_CONFIG_CONTENT'] ?? '{}') as Record<string, unknown>;
  } catch {
    existing = {};
  }
  const permission =
    typeof existing['permission'] === 'object' && existing['permission'] !== null
      ? (existing['permission'] as Record<string, unknown>)
      : {};
  return {
    OPENCODE_CONFIG_CONTENT: JSON.stringify({
      ...existing,
      permission: { ...permission, bash: 'ask', edit: 'ask', webfetch: 'ask' },
    }),
  };
}

export const ACP_PRESETS = {
  claude: {
    id: 'claude-acp',
    name: 'Claude Code (ACP)',
    commands: [{ command: 'claude-agent-acp' }, { command: 'claude-code-acp' }],
    installHint:
      'Install the Claude Code ACP bridge (claude-agent-acp, github.com/agentclientprotocol/claude-agent-acp) and make sure it is on PATH.',
    description:
      "Anthropic's Claude Code through its ACP bridge. It asks before each tool call, so Odysseus can approve or deny every action.",
    homepage: 'https://github.com/agentclientprotocol/claude-agent-acp',
    tags: ['anthropic', 'claude', 'acp'],
  },
  codex: {
    id: 'codex-acp',
    name: 'Codex (ACP)',
    commands: [{ command: 'codex-acp' }],
    installHint: 'Install the Codex ACP bridge (codex-acp) and make sure it is on PATH.',
    description:
      "OpenAI's Codex through its ACP bridge, with each tool call approved or denied in Odysseus.",
    tags: ['openai', 'codex', 'acp'],
  },
  gemini: {
    id: 'gemini-acp',
    name: 'Gemini CLI (ACP)',
    commands: [{ command: 'gemini', args: ['--experimental-acp'] }],
    installHint: 'Install the Gemini CLI (`gemini`) with ACP support and make sure it is on PATH.',
    description:
      "Google's Gemini CLI in its ACP mode, with each tool call approved or denied in Odysseus.",
    tags: ['google', 'gemini', 'acp'],
  },
  opencode: {
    id: 'opencode-acp',
    name: 'OpenCode (ACP)',
    commands: [{ command: 'opencode', args: ['acp'] }],
    askEnvironment: openCodeAsks,
    installHint: 'Install OpenCode (`opencode`) and make sure it is on PATH.',
    description: 'OpenCode in its ACP mode, with each tool call approved or denied in Odysseus.',
    tags: ['opencode', 'acp'],
  },
} satisfies Record<string, AcpAgentPreset>;
