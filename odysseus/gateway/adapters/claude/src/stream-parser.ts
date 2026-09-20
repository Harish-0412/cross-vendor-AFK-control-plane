/**
 * Translates Claude Code's stream-json output into Odysseus event envelopes.
 *
 * This is the only place that understands Claude Code's wire format. Every
 * mapping decision is explicit, and anything unrecognised is surfaced rather
 * than dropped — a silently swallowed event is a session that looks idle while
 * the agent is working.
 */
import type { EventEnvelope, EventType } from '@odysseus/protocol';
import { generateEventId, EVENT_VERSION } from '@odysseus/protocol';

import type {
  ClaudeAssistantMessage,
  ClaudeContentBlock,
  ClaudeResultMessage,
  ClaudeStreamMessage,
  ClaudeUserMessage,
} from './types';

export interface ParsedLine {
  envelopes: EventEnvelope[];
  /** Claude Code's own session id, captured from the init event. */
  claudeSessionId?: string;
  /** True once the final result message has been seen. */
  terminal?: boolean;
  /** Set when the run ended in failure. */
  error?: string;
}

export class ClaudeStreamParser {
  private sequence = 0;

  constructor(
    private readonly sessionId: string,
    private readonly deviceId?: string,
  ) {}

  private envelope(eventType: EventType, payload: unknown): EventEnvelope {
    return {
      eventId: generateEventId(),
      eventType,
      eventVersion: EVENT_VERSION,
      sessionId: this.sessionId,
      ...(this.deviceId ? { deviceId: this.deviceId } : {}),
      sequence: this.sequence++,
      occurredAt: new Date(),
      payload,
    } as EventEnvelope;
  }

  /**
   * Parse one line of stdout.
   *
   * Claude Code writes newline-delimited JSON, but a line that is not JSON
   * (a warning, a stray write) must not kill the session — it is reported as
   * output instead.
   */
  parseLine(line: string): ParsedLine {
    const trimmed = line.trim();
    if (!trimmed) return { envelopes: [] };

    let message: ClaudeStreamMessage;
    try {
      message = JSON.parse(trimmed) as ClaudeStreamMessage;
    } catch {
      return {
        envelopes: [
          this.envelope('session.output', {
            stream: 'stdout',
            content: trimmed,
            timestamp: new Date(),
          }),
        ],
      };
    }

    return this.parseMessage(message);
  }

  parseMessage(message: ClaudeStreamMessage): ParsedLine {
    switch (message.type) {
      case 'system':
        return this.parseSystem(message as Extract<ClaudeStreamMessage, { type: 'system' }>);
      case 'assistant':
        return { envelopes: this.parseAssistant(message) };
      case 'user':
        return { envelopes: this.parseUser(message) };
      case 'stream_event':
        return { envelopes: this.parseStreamEvent(message) };
      case 'result':
        return this.parseResult(message);
      default:
        return {
          envelopes: [
            this.envelope('session.output', {
              stream: 'stdout',
              content: JSON.stringify(message),
              timestamp: new Date(),
            }),
          ],
        };
    }
  }

  private parseSystem(
    message: Extract<ClaudeStreamMessage, { type: 'system' }>,
  ): ParsedLine {
    if (message.subtype === 'init') {
      const init = message as Extract<ClaudeStreamMessage, { type: 'system'; subtype: 'init' }>;
      return {
        // session.started is what the Control Plane waits for before marking a
        // session running, so it must come from a real init event.
        envelopes: [
          this.envelope('session.started', {
            adapter: 'claude-code',
            claudeSessionId: init.session_id,
            model: init.model,
            tools: init.tools,
            mcpServers: init.mcp_servers,
            mcpServerErrors: init.mcp_server_errors,
            pluginErrors: init.plugin_errors,
            capabilities: init.capabilities,
          }),
        ],
        claudeSessionId: init.session_id,
      };
    }

    if (message.subtype === 'api_retry') {
      const retry = message as Extract<
        ClaudeStreamMessage,
        { type: 'system'; subtype: 'api_retry' }
      >;
      return {
        envelopes: [
          this.envelope('session.status_changed', {
            state: 'running',
            reason: `API retry ${retry.attempt}/${retry.max_retries} (${retry.error})`,
            retryDelayMs: retry.retry_delay_ms,
            errorStatus: retry.error_status,
          }),
        ],
      };
    }

    if (message.subtype === 'permission_denied') {
      const denied = message as Extract<
        ClaudeStreamMessage,
        { type: 'system'; subtype: 'permission_denied' }
      >;
      // A denial is a governance outcome, not noise: it is surfaced both as an
      // approval decision and as a policy violation so the audit trail sees it.
      return {
        envelopes: [
          this.envelope('session.approval_denied', {
            approvalId: denied.tool_use_id ?? 'unknown',
            tool: denied.tool_name,
            reason: denied.reason ?? 'Denied by permission policy',
            decidedBy: 'permission-policy',
          }),
          this.envelope('policy.violation', {
            capability: denied.tool_name ?? 'unknown',
            reason: denied.reason ?? 'Denied by permission policy',
            action: 'denied',
          }),
        ],
      };
    }

    return {
      envelopes: [
        this.envelope('session.output', {
          stream: 'stdout',
          content: JSON.stringify(message),
          timestamp: new Date(),
        }),
      ],
    };
  }

  private parseAssistant(message: ClaudeAssistantMessage): EventEnvelope[] {
    const envelopes: EventEnvelope[] = [];
    const fromSubagent = Boolean(message.parent_tool_use_id);

    for (const block of message.message?.content ?? []) {
      envelopes.push(...this.parseBlock(block, { fromSubagent, parent: message.parent_tool_use_id }));
    }
    return envelopes;
  }

  private parseBlock(
    block: ClaudeContentBlock,
    context: { fromSubagent: boolean; parent?: string | null | undefined },
  ): EventEnvelope[] {
    const common = context.fromSubagent
      ? { fromSubagent: true, parentToolUseId: context.parent }
      : {};

    switch (block.type) {
      case 'text':
        if (!block.text) return [];
        return [
          this.envelope('session.message', {
            role: 'assistant',
            content: block.text,
            ...common,
          }),
        ];

      case 'thinking':
        if (!block.thinking) return [];
        return [this.envelope('session.thinking', { content: block.thinking, ...common })];

      case 'tool_use':
        return [
          this.envelope('session.tool_call', {
            toolCallId: block.id,
            name: block.name,
            arguments: block.input,
            ...common,
          }),
        ];

      case 'tool_result':
        return [
          this.envelope(block.is_error ? 'session.tool_error' : 'session.tool_result', {
            toolCallId: block.tool_use_id,
            output: block.content,
            isError: Boolean(block.is_error),
            ...common,
          }),
        ];

      default:
        return [];
    }
  }

  private parseUser(message: ClaudeUserMessage): EventEnvelope[] {
    const content = message.message?.content;
    const fromSubagent = Boolean(message.parent_tool_use_id);

    if (typeof content === 'string') {
      return [
        this.envelope('session.message', {
          role: 'user',
          content,
          ...(fromSubagent ? { fromSubagent: true } : {}),
        }),
      ];
    }

    const envelopes: EventEnvelope[] = [];
    for (const block of content ?? []) {
      envelopes.push(
        ...this.parseBlock(block, { fromSubagent, parent: message.parent_tool_use_id }),
      );
    }
    return envelopes;
  }

  private parseStreamEvent(
    message: Extract<ClaudeStreamMessage, { type: 'stream_event' }>,
  ): EventEnvelope[] {
    const delta = message.event?.delta;
    if (delta?.type === 'text_delta' && delta.text) {
      return [
        this.envelope('session.output', {
          stream: 'stdout',
          content: delta.text,
          timestamp: new Date(),
          partial: true,
        }),
      ];
    }
    return [];
  }

  private parseResult(message: ClaudeResultMessage): ParsedLine {
    const envelopes: EventEnvelope[] = [];

    // Denials listed on the result are the authoritative record of what the
    // permission policy blocked during the run.
    for (const denial of message.permission_denials ?? []) {
      envelopes.push(
        this.envelope('policy.violation', {
          capability: denial.tool_name ?? 'unknown',
          reason: denial.reason ?? 'Denied by permission policy',
          action: 'denied',
        }),
      );
    }

    if (message.is_error) {
      const error = message.result ?? 'Claude Code reported an error';
      envelopes.push(
        this.envelope('session.failed', {
          error,
          costUsd: message.total_cost_usd,
          turns: message.num_turns,
        }),
      );
      return { envelopes, terminal: true, error, claudeSessionId: message.session_id };
    }

    envelopes.push(
      this.envelope('session.completed', {
        result: message.result,
        structuredOutput: message.structured_output,
        costUsd: message.total_cost_usd,
        turns: message.num_turns,
        durationMs: message.duration_ms,
        usage: message.usage,
      }),
    );

    return { envelopes, terminal: true, claudeSessionId: message.session_id };
  }
}
