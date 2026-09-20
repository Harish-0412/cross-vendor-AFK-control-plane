import type { SessionConfig } from '@odysseus/protocol';
import { describe, test, expect, beforeEach } from 'vitest';

import { ClaudeCodeAdapter } from '../src/claude-adapter';
import { claudeCodeMetadata } from '../src/capabilities';
import { ClaudeProcessManager, permissionModeFor } from '../src/process-manager';
import { ClaudeStreamParser } from '../src/stream-parser';

/** Lines in the shape Claude Code emits with --output-format stream-json. */
const INIT_LINE = JSON.stringify({
  type: 'system',
  subtype: 'init',
  session_id: 'cc_sess_abc123',
  model: 'claude-opus-5',
  tools: ['Bash', 'Read', 'Edit'],
  mcp_servers: [],
  capabilities: ['interrupt_receipt_v1'],
});

const ASSISTANT_TEXT_LINE = JSON.stringify({
  type: 'assistant',
  session_id: 'cc_sess_abc123',
  parent_tool_use_id: null,
  message: {
    id: 'msg_1',
    role: 'assistant',
    model: 'claude-opus-5',
    content: [{ type: 'text', text: 'I will read the file first.' }],
  },
});

const ASSISTANT_TOOL_LINE = JSON.stringify({
  type: 'assistant',
  session_id: 'cc_sess_abc123',
  message: {
    role: 'assistant',
    content: [
      { type: 'thinking', thinking: 'The bug is probably in auth.' },
      { type: 'tool_use', id: 'toolu_1', name: 'Read', input: { file_path: '/tmp/auth.py' } },
    ],
  },
});

const USER_TOOL_RESULT_LINE = JSON.stringify({
  type: 'user',
  session_id: 'cc_sess_abc123',
  message: {
    role: 'user',
    content: [{ type: 'tool_result', tool_use_id: 'toolu_1', content: 'def login(): ...' }],
  },
});

const RESULT_LINE = JSON.stringify({
  type: 'result',
  subtype: 'success',
  session_id: 'cc_sess_abc123',
  is_error: false,
  result: 'Fixed the bug in auth.py',
  total_cost_usd: 0.0412,
  num_turns: 3,
  duration_ms: 18_400,
  permission_denials: [],
});

describe('ClaudeStreamParser', () => {
  let parser: ClaudeStreamParser;

  beforeEach(() => {
    parser = new ClaudeStreamParser('sess_odysseus_1');
  });

  test('the init event yields session.started and captures the Claude session id', () => {
    const parsed = parser.parseLine(INIT_LINE);

    expect(parsed.claudeSessionId).toBe('cc_sess_abc123');
    expect(parsed.envelopes).toHaveLength(1);
    expect(parsed.envelopes[0]?.eventType).toBe('session.started');
    // The Control Plane waits for exactly this event before marking a session
    // running, so it must carry the id needed to resume.
    expect((parsed.envelopes[0]?.payload as Record<string, unknown>).claudeSessionId).toBe(
      'cc_sess_abc123',
    );
  });

  test('assistant text becomes session.message', () => {
    const parsed = parser.parseLine(ASSISTANT_TEXT_LINE);
    expect(parsed.envelopes).toHaveLength(1);
    expect(parsed.envelopes[0]?.eventType).toBe('session.message');
    expect((parsed.envelopes[0]?.payload as Record<string, unknown>).content).toContain(
      'read the file',
    );
  });

  test('thinking and tool_use blocks map to distinct events', () => {
    const parsed = parser.parseLine(ASSISTANT_TOOL_LINE);
    expect(parsed.envelopes.map((e) => e.eventType)).toEqual([
      'session.thinking',
      'session.tool_call',
    ]);

    const call = parsed.envelopes[1]?.payload as Record<string, unknown>;
    expect(call.name).toBe('Read');
    expect(call.toolCallId).toBe('toolu_1');
    expect(call.arguments).toEqual({ file_path: '/tmp/auth.py' });
  });

  test('tool results map to session.tool_result', () => {
    const parsed = parser.parseLine(USER_TOOL_RESULT_LINE);
    expect(parsed.envelopes[0]?.eventType).toBe('session.tool_result');
    expect((parsed.envelopes[0]?.payload as Record<string, unknown>).toolCallId).toBe('toolu_1');
  });

  test('an errored tool result maps to session.tool_error', () => {
    const line = JSON.stringify({
      type: 'user',
      message: {
        role: 'user',
        content: [
          { type: 'tool_result', tool_use_id: 'toolu_2', content: 'ENOENT', is_error: true },
        ],
      },
    });
    const parsed = parser.parseLine(line);
    expect(parsed.envelopes[0]?.eventType).toBe('session.tool_error');
  });

  test('the result event is terminal and carries cost', () => {
    const parsed = parser.parseLine(RESULT_LINE);
    expect(parsed.terminal).toBe(true);
    expect(parsed.error).toBeUndefined();
    expect(parsed.envelopes[0]?.eventType).toBe('session.completed');

    const payload = parsed.envelopes[0]?.payload as Record<string, unknown>;
    expect(payload.costUsd).toBe(0.0412);
    expect(payload.turns).toBe(3);
  });

  test('an error result is terminal and reports the failure', () => {
    const line = JSON.stringify({
      type: 'result',
      session_id: 'cc_sess_abc123',
      is_error: true,
      result: 'Authentication failed',
    });
    const parsed = parser.parseLine(line);
    expect(parsed.terminal).toBe(true);
    expect(parsed.error).toBe('Authentication failed');
    expect(parsed.envelopes[0]?.eventType).toBe('session.failed');
  });

  test('permission denials surface as policy violations', () => {
    const line = JSON.stringify({
      type: 'result',
      session_id: 'cc_sess_abc123',
      is_error: false,
      result: 'done',
      permission_denials: [{ tool_name: 'Bash', tool_use_id: 'toolu_9', reason: 'not allowed' }],
    });
    const parsed = parser.parseLine(line);

    const types = parsed.envelopes.map((e) => e.eventType);
    expect(types).toContain('policy.violation');
    expect(types).toContain('session.completed');
  });

  test('a live permission_denied event is recorded as both a denial and a violation', () => {
    const line = JSON.stringify({
      type: 'system',
      subtype: 'permission_denied',
      tool_name: 'Bash',
      tool_use_id: 'toolu_5',
      reason: 'dontAsk mode denies prompting actions',
    });
    const parsed = parser.parseLine(line);
    expect(parsed.envelopes.map((e) => e.eventType)).toEqual([
      'session.approval_denied',
      'policy.violation',
    ]);
  });

  test('api_retry is surfaced rather than swallowed', () => {
    const line = JSON.stringify({
      type: 'system',
      subtype: 'api_retry',
      attempt: 2,
      max_retries: 5,
      retry_delay_ms: 1000,
      error_status: 529,
      error: 'overloaded',
    });
    const parsed = parser.parseLine(line);
    expect(parsed.envelopes[0]?.eventType).toBe('session.status_changed');
    expect(String((parsed.envelopes[0]?.payload as Record<string, unknown>).reason)).toContain(
      'overloaded',
    );
  });

  test('subagent messages are tagged with their parent tool call', () => {
    const line = JSON.stringify({
      type: 'assistant',
      parent_tool_use_id: 'toolu_agent_1',
      message: { role: 'assistant', content: [{ type: 'text', text: 'subagent output' }] },
    });
    const parsed = parser.parseLine(line);
    const payload = parsed.envelopes[0]?.payload as Record<string, unknown>;
    expect(payload.fromSubagent).toBe(true);
    expect(payload.parentToolUseId).toBe('toolu_agent_1');
  });

  test('a non-JSON line is reported as output, not dropped or fatal', () => {
    const parsed = parser.parseLine('Warning: 1 MCP server skipped');
    expect(parsed.envelopes).toHaveLength(1);
    expect(parsed.envelopes[0]?.eventType).toBe('session.output');
  });

  test('blank lines produce nothing', () => {
    expect(parser.parseLine('   ').envelopes).toHaveLength(0);
  });

  test('sequence numbers increase monotonically across a whole run', () => {
    const lines = [INIT_LINE, ASSISTANT_TEXT_LINE, ASSISTANT_TOOL_LINE, RESULT_LINE];
    const sequences: number[] = [];
    for (const line of lines) {
      for (const envelope of parser.parseLine(line).envelopes) sequences.push(envelope.sequence);
    }
    expect(sequences).toEqual([...sequences].sort((a, b) => a - b));
    expect(new Set(sequences).size).toBe(sequences.length);
  });
});

describe('CLI argument construction', () => {
  const manager = new ClaudeProcessManager({ binaryPath: 'claude' });

  function args(config?: Partial<SessionConfig>, resume?: string): string[] {
    return manager.buildArgs({
      prompt: 'fix the bug',
      ...(config ? { config: config as SessionConfig } : {}),
      ...(resume ? { resumeSessionId: resume } : {}),
    });
  }

  test('stream-json is always paired with --verbose', () => {
    const built = args();
    // Claude Code rejects stream-json without --verbose.
    expect(built).toContain('--output-format');
    expect(built[built.indexOf('--output-format') + 1]).toBe('stream-json');
    expect(built).toContain('--verbose');
  });

  test('the prompt is passed with -p', () => {
    const built = args();
    expect(built[built.indexOf('-p') + 1]).toBe('fix the bug');
  });

  test('bare mode is on by default so repo hooks and MCP servers do not run implicitly', () => {
    expect(args()).toContain('--bare');
  });

  test('a follow-up turn resumes the same Claude conversation', () => {
    const built = args(undefined, 'cc_sess_abc123');
    expect(built[built.indexOf('--resume') + 1]).toBe('cc_sess_abc123');
  });

  test('unattended runs never wait on a permission prompt', () => {
    const built = args();
    expect(built[built.indexOf('--permission-prompts') + 1]).toBe('none');
  });

  test('approvalMode maps onto a permission mode', () => {
    expect(permissionModeFor('never')).toBe('dontAsk');
    expect(permissionModeFor('auto')).toBe('auto');
    // 'ask' has no safe mapping without a permission host, so it falls back to
    // the locked-down mode; the capability check rejects it before this point.
    expect(permissionModeFor('ask')).toBe('dontAsk');
  });

  test('model and maxTurns are threaded through', () => {
    const built = args({ model: 'claude-opus-5', maxTurns: 4 });
    expect(built[built.indexOf('--model') + 1]).toBe('claude-opus-5');
    expect(built[built.indexOf('--max-turns') + 1]).toBe('4');
  });
});

describe('ClaudeCodeAdapter contract', () => {
  let adapter: ClaudeCodeAdapter;

  beforeEach(() => {
    adapter = new ClaudeCodeAdapter();
  });

  test('implements every required AgentAdapter method', () => {
    const required = [
      'metadata',
      'installOrDetect',
      'validateEnvironment',
      'startSession',
      'sendMessage',
      'sendInput',
      'streamEvents',
      'requestApproval',
      'submitApprovalDecision',
      'abortSession',
      'collectDiff',
      'getState',
      'getSession',
      'cleanupSession',
    ] as const;

    for (const method of required) {
      expect(typeof (adapter as unknown as Record<string, unknown>)[method]).toBe('function');
    }
  });

  test('metadata id matches the manifest', () => {
    expect(adapter.metadata().id).toBe('claude-code');
  });

  test('declares approval interception as unsupported rather than pretending', () => {
    // Overstating this would let a session run ungoverned while appearing
    // supervised. The gateway rejects approvalMode 'ask' against it instead.
    expect(claudeCodeMetadata().capabilities.approvalInterception).toBe('unsupported');
  });

  test('requestApproval refuses clearly instead of silently approving', async () => {
    const result = await adapter.requestApproval('sess_1', {
      id: 'a1',
      type: 'bash_exec',
      description: 'rm -rf /',
      riskLevel: 'critical',
      details: {},
    });
    expect(result.approved).toBe(false);
    expect(result.reason).toContain('cannot intercept');
  });

  test('unknown sessions raise rather than returning empty state', async () => {
    await expect(adapter.getState('nope')).rejects.toThrow(/Unknown Claude Code session/);
    expect(await adapter.getSession('nope')).toBeUndefined();
  });

  test('startSession fails clearly when the CLI is absent', async () => {
    const absent = new ClaudeCodeAdapter({
      detect: async () => null,
      validate: async () => ({
        valid: false,
        errors: ['not installed'],
        warnings: [],
      }),
      run: () => {
        throw new Error('should not run');
      },
      stop: async () => undefined,
    });

    // No simulation fallback: an absent CLI is reported, not faked.
    await expect(
      absent.startSession({ adapter: 'claude-code', projectRoot: process.cwd() } as SessionConfig),
    ).rejects.toThrow(/not installed/i);

    const detection = await absent.installOrDetect();
    expect(detection.success).toBe(false);
    expect(detection.error?.code).toBe('CLAUDE_CODE_NOT_FOUND');
  });

  test('cleanupSession on an unknown id is a no-op', async () => {
    await expect(adapter.cleanupSession('nope')).resolves.toBeUndefined();
  });
});
