/**
 * Claude Code's `--output-format stream-json` wire format.
 *
 * Deliberately contained in this package: the rest of Odysseus only ever sees
 * `EventEnvelope`, so a change to Claude Code's output shape is a change to
 * this file and the parser, and nowhere else.
 *
 * Shapes follow the documented headless output: a `system`/`init` event first
 * (carrying `session_id`, model, tools and MCP server status), then
 * `assistant` / `user` messages, optional `stream_event` partials when
 * `--include-partial-messages` is set, and a final `result` message.
 */

export type ClaudeStreamMessage =
  | ClaudeSystemInit
  | ClaudeSystemApiRetry
  | ClaudeSystemPermissionDenied
  | ClaudeSystemOther
  | ClaudeAssistantMessage
  | ClaudeUserMessage
  | ClaudeStreamEvent
  | ClaudeResultMessage;

export interface ClaudeSystemInit {
  type: 'system';
  subtype: 'init';
  session_id: string;
  model?: string;
  tools?: string[];
  mcp_servers?: Array<{ name: string; status: string }>;
  mcp_server_errors?: Array<{ name: string; type: string; message: string }>;
  plugins?: Array<{ name: string; path: string }>;
  plugin_errors?: Array<{ plugin: string; type: string; message: string }>;
  capabilities?: string[];
  uuid?: string;
}

export interface ClaudeSystemApiRetry {
  type: 'system';
  subtype: 'api_retry';
  attempt: number;
  max_retries: number;
  retry_delay_ms: number;
  error_status: number | null;
  error: string;
  session_id?: string;
  uuid?: string;
}

export interface ClaudeSystemPermissionDenied {
  type: 'system';
  subtype: 'permission_denied';
  session_id?: string;
  tool_name?: string;
  tool_use_id?: string;
  reason?: string;
  uuid?: string;
}

export interface ClaudeSystemOther {
  type: 'system';
  subtype: string;
  session_id?: string;
  [key: string]: unknown;
}

/** An Anthropic Messages API content block as it appears in the stream. */
export interface ClaudeContentBlock {
  type: 'text' | 'thinking' | 'tool_use' | 'tool_result' | string;
  text?: string;
  thinking?: string;
  id?: string;
  name?: string;
  input?: unknown;
  tool_use_id?: string;
  content?: unknown;
  is_error?: boolean;
}

export interface ClaudeAssistantMessage {
  type: 'assistant';
  session_id?: string;
  /** Non-null when the message came from a subagent. */
  parent_tool_use_id?: string | null;
  message: {
    id?: string;
    role: 'assistant';
    model?: string;
    content: ClaudeContentBlock[];
    stop_reason?: string | null;
    usage?: Record<string, unknown>;
  };
  uuid?: string;
}

export interface ClaudeUserMessage {
  type: 'user';
  session_id?: string;
  parent_tool_use_id?: string | null;
  message: {
    role: 'user';
    content: ClaudeContentBlock[] | string;
  };
  uuid?: string;
}

/** Emitted only with --include-partial-messages. */
export interface ClaudeStreamEvent {
  type: 'stream_event';
  session_id?: string;
  parent_tool_use_id?: string | null;
  event: {
    type: string;
    delta?: { type?: string; text?: string; thinking?: string };
    index?: number;
  };
  uuid?: string;
}

export interface ClaudeResultMessage {
  type: 'result';
  subtype?: string;
  session_id: string;
  is_error?: boolean;
  result?: string;
  structured_output?: unknown;
  total_cost_usd?: number;
  num_turns?: number;
  duration_ms?: number;
  usage?: Record<string, unknown>;
  permission_denials?: Array<{ tool_name?: string; tool_use_id?: string; reason?: string }>;
  uuid?: string;
}

export interface ClaudeProcessOptions {
  /** Override the `claude` binary path. */
  binaryPath?: string;
  /** Model id passed to --model. */
  model?: string;
  /**
   * Skip discovery of the host's hooks, plugins, MCP servers and CLAUDE.md.
   * Recommended for gateway-run sessions: it makes a run reproducible and
   * stops repository content from executing implicitly.
   */
  bare?: boolean;
  /** Extra CLI arguments, appended last. */
  extraArgs?: string[];
  /** Milliseconds to wait for `claude --version` during detection. */
  detectTimeoutMs?: number;
}
