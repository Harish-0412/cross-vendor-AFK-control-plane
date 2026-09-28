/**
 * One adapter for every agent that speaks the Agent Client Protocol (ACP,
 * agentclientprotocol.com): Claude Code, Codex, Gemini CLI, OpenCode and
 * whatever adopts it next.
 *
 * The agent runs as a child process speaking JSON-RPC over stdio, and ACP
 * makes the agent ask the client before a tool call it wants approved. That
 * question becomes an Odysseus approval: the Control Plane scores the exact
 * command or file, settles it by policy where it can, and otherwise asks a
 * person. Odysseus answers "allow once" or "reject once" — never "always",
 * because Odysseus remembers approvals itself, under its own rules.
 *
 * The agent may also ask the client to read and write files. Those go through
 * this adapter, so they stay inside the project, and the deny floor applies:
 * no agent may write the files that make tools run commands by themselves.
 */
import { spawn, type ChildProcess, type SpawnOptions } from 'node:child_process';
import { existsSync, promises as fs, realpathSync, statSync } from 'node:fs';
import { delimiter, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';

import { denyFloorMatches } from '@odysseus/policy-engine';
import type {
  AgentAdapter,
  AgentInstallationResult,
  AgentMetadata,
  AgentValidationResult,
  ApprovalAction,
  Capability,
  EventEnvelope,
  EventStream,
  EventSubscriber,
  EventType,
  Session,
  SessionConfig,
  SessionState,
} from '@odysseus/protocol';
import { generateEventId, generateSessionId } from '@odysseus/protocol';

import { AcpConnection, RpcCode, RpcError } from './connection';
import { AdapterEventStream } from './event-stream';
import type { AcpAgentPreset } from './presets';
import { resolveCommand, type ResolvedCommand } from './resolve-command';
import { safeGitDiff } from './safe-git';

/** The ACP major version this client speaks. */
export const ACP_PROTOCOL_VERSION = 1;
const CLIENT_VERSION = '0.1.0';
/** A question nobody answered is refused after this, so an agent never hangs. */
const DEFAULT_PERMISSION_TIMEOUT_MS = 35 * 60_000;
/** Streamed text is published in pieces this big, or after this long quiet. */
const FLUSH_CHARS = 4_000;
const FLUSH_IDLE_MS = 1_000;
const MAX_TOOL_OUTPUT_CHARS = 8_000;

const STOP_REASON_TEXT: Record<string, string> = {
  max_tokens: 'The agent stopped: it reached its token limit.',
  max_turn_requests: 'The agent stopped: it made too many model requests in one turn.',
  refusal: 'The agent refused to continue.',
};

interface PermissionOption {
  optionId: string;
  name?: string;
  kind?: string;
}

interface PendingPermission {
  options: PermissionOption[];
  resolve: (outcome: unknown) => void;
  timer: NodeJS.Timeout;
}

interface ToolCallState {
  title?: string | undefined;
  kind?: string | undefined;
  rawInput?: unknown;
  locations?: Array<{ path?: string; line?: number }> | undefined;
}

interface AcpSession {
  id: string;
  projectRoot: string;
  config: SessionConfig;
  stream: AdapterEventStream;
  session: Session;
  state: SessionState;
  child: ChildProcess;
  connection: AcpConnection;
  acpSessionId?: string;
  /** Updates replayed by session/load describe the past; they are not republished. */
  replaying: boolean;
  turns: Promise<void>;
  buffer: { role: 'assistant' | 'thinking'; text: string } | null;
  flushTimer?: NodeJS.Timeout | undefined;
  lastAssistantText: string;
  permissions: Map<string, PendingPermission>;
  toolCalls: Map<string, ToolCallState>;
  stderr: string[];
  sequence: number;
  permissionCount: number;
  ended: boolean;
}

export interface AcpAdapterOptions {
  env?: NodeJS.ProcessEnv;
  platform?: NodeJS.Platform;
  spawn?: (command: string, args: string[], options: SpawnOptions) => ChildProcess;
  /** Replaces PATH lookup; for tests and explicit configuration. */
  locate?: (command: string) => ResolvedCommand | null;
  permissionTimeoutMs?: number;
}

export class AcpAdapter implements AgentAdapter {
  private readonly sessions = new Map<string, AcpSession>();
  private agentVersion = 'unknown';

  constructor(
    private readonly preset: AcpAgentPreset,
    private readonly options: AcpAdapterOptions = {},
  ) {}

  metadata(): AgentMetadata {
    return {
      id: this.preset.id,
      name: this.preset.name,
      version: this.agentVersion,
      platform: ['linux', 'darwin', 'win32'],
      capabilities: {
        sessionCreation: 'supported',
        promptDelivery: 'supported',
        streaming: 'supported',
        cancellation: 'supported',
        diffCollection: 'partial',
        // The point of ACP: the agent asks before tool calls, and waits.
        approvalInterception: 'supported',
        // session/load, where the agent supports it.
        checkpointRecovery: 'partial',
        multiTurn: 'supported',
        fileOperations: 'supported',
        toolExecution: 'supported',
      },
      description: this.preset.description,
      ...(this.preset.homepage ? { homepage: this.preset.homepage } : {}),
      tags: this.preset.tags,
    };
  }

  async installOrDetect(): Promise<AgentInstallationResult> {
    const found = this.locate();
    if (!found)
      return {
        success: false,
        error: { code: 'ACP_AGENT_NOT_FOUND', message: this.preset.installHint, retryable: true },
      };
    return { success: true, installedVersion: this.agentVersion, path: found.resolved.command };
  }

  async validateEnvironment(): Promise<AgentValidationResult> {
    const found = this.locate();
    return {
      valid: Boolean(found),
      errors: found ? [] : [this.preset.installHint],
      warnings: [],
      checks: { binary_present: Boolean(found) },
    };
  }

  // ------------------------------------------------------------- sessions

  async startSession(config: SessionConfig): Promise<string> {
    const found = this.locate();
    if (!found) throw new Error(`${this.preset.name} is not installed. ${this.preset.installHint}`);

    const id = generateSessionId();
    const baseEnv = this.options.env ?? process.env;
    const child = (this.options.spawn ?? spawn)(
      found.resolved.command,
      [...found.resolved.prefixArgs, ...found.args],
      {
        cwd: config.projectRoot,
        stdio: ['pipe', 'pipe', 'pipe'],
        windowsHide: true,
        // Some agents only ask before acting when told to.
        env: { ...baseEnv, ...(this.preset.askEnvironment?.(baseEnv) ?? {}) },
      },
    );
    const record: AcpSession = {
      id,
      projectRoot: config.projectRoot,
      config,
      stream: new AdapterEventStream(),
      session: {
        id,
        projectId: config.projectRoot,
        adapterId: this.preset.id,
        state: 'initializing',
        startTime: new Date(),
        sequenceNumber: 0,
        metadata: { projectRoot: config.projectRoot },
      },
      state: 'initializing',
      child,
      connection: new AcpConnection(child.stdout!, child.stdin!, (line) =>
        keep(record.stderr, line),
      ),
      replaying: false,
      turns: Promise.resolve(),
      buffer: null,
      lastAssistantText: '',
      permissions: new Map(),
      toolCalls: new Map(),
      stderr: [],
      sequence: 0,
      permissionCount: 0,
      ended: false,
    };
    this.sessions.set(id, record);

    child.stderr?.setEncoding('utf8');
    child.stderr?.on('data', (chunk: string) => {
      for (const line of chunk.split(/\r?\n/)) if (line.trim()) keep(record.stderr, line);
    });
    child.on('error', (error) =>
      this.fail(record, `Could not start ${this.preset.name}: ${error.message}`),
    );
    child.on('exit', (code, signal) => {
      record.connection.close(`${this.preset.name} exited`);
      this.answerAllPermissions(record, { outcome: { outcome: 'cancelled' } });
      if (!record.ended && record.state !== 'cancelled' && record.state !== 'completed')
        this.fail(
          record,
          `${this.preset.name} exited unexpectedly (${signal ?? `code ${String(code)}`})`,
          'session.crashed',
        );
    });

    record.connection.onNotification((method, params) => {
      if (method === 'session/update') this.onUpdate(record, params);
    });
    record.connection.onRequest((method, params) => this.onAgentRequest(record, method, params));

    try {
      await this.open(record);
    } catch (error) {
      record.ended = true;
      this.stopProcess(record);
      this.sessions.delete(id);
      throw error instanceof Error ? error : new Error(String(error));
    }

    record.state = 'running';
    record.session.state = 'running';
    this.publish(record, 'session.started', {
      adapter: this.preset.id,
      acpSessionId: record.acpSessionId,
      agentVersion: this.agentVersion,
    });
    if (config.prompt) this.queueTurn(record, config.prompt);
    return id;
  }

  /** Handshake, then a new session — or the old one, when resuming after a restart. */
  private async open(record: AcpSession): Promise<void> {
    const init = await record.connection.request<{
      protocolVersion?: number;
      agentCapabilities?: { loadSession?: boolean };
      agentInfo?: { version?: string };
    }>(
      'initialize',
      {
        protocolVersion: ACP_PROTOCOL_VERSION,
        clientCapabilities: { fs: { readTextFile: true, writeTextFile: true }, terminal: false },
        clientInfo: { name: 'odysseus', title: 'Odysseus', version: CLIENT_VERSION },
      },
      60_000,
    );
    if (init.protocolVersion !== ACP_PROTOCOL_VERSION)
      throw new Error(
        `${this.preset.name} speaks ACP version ${String(init.protocolVersion)}; Odysseus speaks ${ACP_PROTOCOL_VERSION}.`,
      );
    if (init.agentInfo?.version) this.agentVersion = init.agentInfo.version;

    const resume = record.config.metadata?.['resumeNativeSessionId'];
    try {
      if (typeof resume === 'string' && resume && init.agentCapabilities?.loadSession) {
        record.replaying = true;
        await record.connection.request(
          'session/load',
          { sessionId: resume, cwd: record.projectRoot, mcpServers: [] },
          120_000,
        );
        record.acpSessionId = resume;
      } else {
        const created = await record.connection.request<{ sessionId?: string }>(
          'session/new',
          { cwd: record.projectRoot, mcpServers: [] },
          120_000,
        );
        if (!created.sessionId) throw new Error('The agent did not return a session id');
        record.acpSessionId = created.sessionId;
      }
    } catch (error) {
      if (error instanceof RpcError && /auth/i.test(error.message))
        throw new Error(
          `${this.preset.name} needs you to sign in first: run it once in a terminal on this machine. (${error.message})`,
        );
      throw error;
    } finally {
      record.replaying = false;
    }
  }

  private queueTurn(record: AcpSession, prompt: string): void {
    record.turns = record.turns.then(() => this.runTurn(record, prompt)).catch(() => undefined);
  }

  private async runTurn(record: AcpSession, prompt: string): Promise<void> {
    if (record.ended || !record.acpSessionId) return;
    record.state = 'running';
    record.session.state = 'running';
    try {
      const result = await record.connection.request<{ stopReason?: string }>('session/prompt', {
        sessionId: record.acpSessionId,
        prompt: [{ type: 'text', text: prompt }],
      });
      this.flush(record);
      const stopReason = result.stopReason ?? 'end_turn';
      if (stopReason === 'cancelled') return; // abortSession reports it
      if (stopReason === 'end_turn') {
        record.state = 'completed';
        record.session.state = 'completed';
        record.session.endTime = new Date();
        this.publish(record, 'session.completed', { result: record.lastAssistantText, stopReason });
        return;
      }
      this.fail(
        record,
        STOP_REASON_TEXT[stopReason] ?? `The agent stopped: ${stopReason}`,
        'session.failed',
        {
          stopReason,
        },
      );
    } catch (error) {
      this.flush(record);
      // abortSession may have cancelled the session while the turn was running.
      if (record.ended || (record.state as SessionState) === 'cancelled') return;
      const tail = record.stderr.slice(-10).join('\n');
      this.fail(record, `${(error as Error).message}${tail ? `\n${tail}` : ''}`);
    }
  }

  async sendMessage(sessionId: string, message: string): Promise<void> {
    const record = this.requireSession(sessionId);
    if (record.ended || record.state === 'cancelled' || record.state === 'crashed')
      throw new Error(`Session ${sessionId} is ${record.state}; cannot send a message`);
    this.queueTurn(record, message);
  }

  async sendInput(sessionId: string, data: string): Promise<void> {
    return this.sendMessage(sessionId, data);
  }

  streamEvents(sessionId: string, subscriber?: Partial<EventSubscriber>): EventStream {
    const record = this.requireSession(sessionId);
    if (subscriber) record.stream.subscribe(subscriber);
    return record.stream;
  }

  // ------------------------------------------------------------ approvals

  async requestApproval(
    _sessionId: string,
    action: ApprovalAction,
  ): Promise<{ approved: boolean; reason?: string }> {
    // Over ACP the agent asks for permission itself (session/request_permission);
    // there is no separate gateway-initiated question to put to it.
    return { approved: false, reason: `ACP agents ask for permission themselves (${action.type})` };
  }

  async submitApprovalDecision(
    sessionId: string,
    approvalId: string,
    approved: boolean,
  ): Promise<void> {
    const record = this.requireSession(sessionId);
    const pending = record.permissions.get(approvalId);
    if (!pending) throw new Error(`No pending permission request ${approvalId}`);
    clearTimeout(pending.timer);
    record.permissions.delete(approvalId);
    pending.resolve(chooseOutcome(pending.options, approved));
    if (record.permissions.size === 0 && record.state === 'waiting_for_approval') {
      record.state = 'running';
      record.session.state = 'running';
    }
  }

  // ------------------------------------------------------------- ending

  async abortSession(sessionId: string, reason: string, force = false): Promise<void> {
    const record = this.requireSession(sessionId);
    if (record.ended) return;
    record.state = 'cancelled';
    record.session.state = 'cancelled';
    record.session.endTime = new Date();
    // ACP: every open permission request is answered "cancelled" before the turn ends.
    this.answerAllPermissions(record, { outcome: { outcome: 'cancelled' } });
    if (record.acpSessionId)
      record.connection.notify('session/cancel', { sessionId: record.acpSessionId });
    this.flush(record);
    record.ended = true;
    this.publish(record, 'session.cancelled', { reason, force });
    if (force) this.stopProcess(record);
    else setTimeout(() => this.stopProcess(record), 2_000).unref?.();
  }

  async collectDiff(sessionId: string): Promise<string> {
    return safeGitDiff(this.requireSession(sessionId).projectRoot);
  }

  async getState(sessionId: string): Promise<SessionState> {
    return this.requireSession(sessionId).state;
  }

  async getSession(sessionId: string): Promise<Session | undefined> {
    return this.sessions.get(sessionId)?.session;
  }

  async cleanupSession(sessionId: string): Promise<void> {
    const record = this.sessions.get(sessionId);
    if (!record) return;
    record.ended = true;
    this.answerAllPermissions(record, { outcome: { outcome: 'cancelled' } });
    this.stopProcess(record);
    record.stream.close();
    this.sessions.delete(sessionId);
  }

  /** The agent's own session id; resuming loads it with session/load. */
  async checkpointSession(sessionId: string): Promise<string> {
    const acpSessionId = this.requireSession(sessionId).acpSessionId;
    if (!acpSessionId) throw new Error(`Session ${sessionId} has no ACP session yet`);
    return acpSessionId;
  }

  async shutdown(): Promise<void> {
    await Promise.all([...this.sessions.keys()].map((id) => this.cleanupSession(id)));
  }

  // --------------------------------------------------- agent → client

  private async onAgentRequest(
    record: AcpSession,
    method: string,
    params: unknown,
  ): Promise<unknown> {
    switch (method) {
      case 'session/request_permission':
        return this.askPermission(record, params as Record<string, unknown>);
      case 'fs/read_text_file':
        return this.readFile(record, params as { path?: unknown; line?: unknown; limit?: unknown });
      case 'fs/write_text_file':
        return this.writeFile(record, params as { path?: unknown; content?: unknown });
      default:
        throw new RpcError(RpcCode.METHOD_NOT_FOUND, `Odysseus does not provide ${method}`);
    }
  }

  /** The agent asks before a tool call: that question becomes an Odysseus approval. */
  private askPermission(record: AcpSession, params: Record<string, unknown>): Promise<unknown> {
    const subject = params['subject'] as { toolCall?: Record<string, unknown> } | undefined;
    const toolCall = (params['toolCall'] ?? subject?.toolCall ?? {}) as Record<string, unknown>;
    const toolCallId = typeof toolCall['toolCallId'] === 'string' ? toolCall['toolCallId'] : 'call';
    const known = record.toolCalls.get(toolCallId) ?? {};
    const merged: ToolCallState = {
      ...known,
      ...(typeof toolCall['title'] === 'string' ? { title: toolCall['title'] } : {}),
      ...(typeof toolCall['kind'] === 'string' ? { kind: toolCall['kind'] } : {}),
      ...(toolCall['rawInput'] !== undefined ? { rawInput: toolCall['rawInput'] } : {}),
      ...(Array.isArray(toolCall['locations'])
        ? { locations: toolCall['locations'] as ToolCallState['locations'] }
        : {}),
    };
    const action = describeAction(merged, toolCall['content'], record.projectRoot);
    const options = (
      Array.isArray(params['options']) ? params['options'] : []
    ) as PermissionOption[];
    const approvalId = `acp_${++record.permissionCount}_${toolCallId}`.slice(0, 120);
    const title = typeof params['title'] === 'string' ? params['title'] : merged.title;

    // Registered before it is announced: a decision may arrive at once.
    const answered = new Promise<unknown>((resolve) => {
      const timer = setTimeout(() => {
        record.permissions.delete(approvalId);
        resolve(chooseOutcome(options, false));
      }, this.options.permissionTimeoutMs ?? DEFAULT_PERMISSION_TIMEOUT_MS);
      timer.unref?.();
      record.permissions.set(approvalId, { options, resolve, timer });
    });

    this.flush(record);
    record.state = 'waiting_for_approval';
    record.session.state = 'waiting_for_approval';
    this.publish(record, 'session.approval_required', {
      approvalId,
      capability: action.capability,
      ...(action.command ? { command: action.command } : {}),
      ...(action.resource ? { resource: action.resource } : {}),
      actionType: merged.kind ?? 'tool_call',
      description: title ?? `${this.preset.name} wants to use a tool`,
      toolCallId,
      options: options.map((option) => ({
        optionId: option.optionId,
        name: option.name,
        kind: option.kind,
      })),
    });
    return answered;
  }

  private async readFile(
    record: AcpSession,
    params: { path?: unknown; line?: unknown; limit?: unknown },
  ): Promise<{ content: string }> {
    const path = this.insideProject(record, params.path, 'read');
    const text = await fs.readFile(path, 'utf8');
    const line = typeof params.line === 'number' && params.line >= 1 ? params.line : undefined;
    const limit = typeof params.limit === 'number' && params.limit >= 0 ? params.limit : undefined;
    if (line === undefined && limit === undefined) return { content: text };
    const lines = text.split('\n');
    const start = (line ?? 1) - 1;
    return {
      content: lines.slice(start, limit === undefined ? undefined : start + limit).join('\n'),
    };
  }

  private async writeFile(
    record: AcpSession,
    params: { path?: unknown; content?: unknown },
  ): Promise<null> {
    if (typeof params.content !== 'string')
      throw new RpcError(RpcCode.INVALID_PARAMS, 'content must be a string');
    const path = this.insideProject(record, params.path, 'write');
    const shown = toPosix(relative(record.projectRoot, path));
    await fs.mkdir(dirname(path), { recursive: true });
    await fs.writeFile(path, params.content, 'utf8');
    this.publish(record, 'session.file_changed', { path: shown, source: 'acp' });
    return null;
  }

  /**
   * The absolute path an agent named, if it is inside the project and the
   * deny floor allows it. Symlinks are followed, so a link cannot lead out.
   */
  private insideProject(record: AcpSession, value: unknown, mode: 'read' | 'write'): string {
    if (typeof value !== 'string' || !isAbsolute(value))
      throw new RpcError(RpcCode.INVALID_PARAMS, 'path must be an absolute path');
    const root = realOrSelf(resolve(record.projectRoot));
    const real = resolveReal(resolve(value));
    if (real !== root && !real.startsWith(root + sep))
      throw new RpcError(
        RpcCode.INVALID_PARAMS,
        `Odysseus keeps agents inside the project: ${value} is outside it`,
      );
    const shown = toPosix(relative(root, real));
    const floor = denyFloorMatches(mode === 'write' ? 'filesystem.write' : 'secret.read', shown);
    if (floor.matched) {
      this.publish(record, 'policy.violation', {
        reason: 'deny-floor',
        description: `${this.preset.name} tried to ${mode} ${shown}, which agents may never ${mode === 'write' ? 'change' : 'read'}.`,
        path: shown,
        ruleId: floor.ruleId,
      });
      throw new RpcError(
        RpcCode.INVALID_PARAMS,
        `Odysseus policy does not allow agents to ${mode} ${shown}`,
      );
    }
    if (mode === 'read' && existsSync(real) && statSync(real).isDirectory())
      throw new RpcError(RpcCode.INVALID_PARAMS, `${value} is a directory`);
    return real;
  }

  // --------------------------------------------------------- updates

  private onUpdate(record: AcpSession, params: unknown): void {
    const { sessionId, update } = (params ?? {}) as {
      sessionId?: string;
      update?: Record<string, unknown>;
    };
    if (!update || record.replaying || record.ended) return;
    if (record.acpSessionId && sessionId !== record.acpSessionId) return;

    switch (update['sessionUpdate']) {
      case 'agent_message_chunk':
        this.append(record, 'assistant', contentText(update['content']));
        return;
      case 'agent_thought_chunk':
        this.append(record, 'thinking', contentText(update['content']));
        return;
      case 'tool_call': {
        this.flush(record);
        const toolCallId = String(update['toolCallId'] ?? '');
        const state: ToolCallState = {
          ...(typeof update['title'] === 'string' ? { title: update['title'] } : {}),
          ...(typeof update['kind'] === 'string' ? { kind: update['kind'] } : {}),
          ...(update['rawInput'] !== undefined ? { rawInput: update['rawInput'] } : {}),
          ...(Array.isArray(update['locations'])
            ? { locations: update['locations'] as ToolCallState['locations'] }
            : {}),
        };
        record.toolCalls.set(toolCallId, state);
        this.publish(record, 'session.tool_call', {
          toolCallId,
          name: state.title ?? state.kind ?? 'tool',
          kind: state.kind,
          arguments: state.rawInput,
          locations: state.locations,
          status: update['status'],
        });
        return;
      }
      case 'tool_call_update': {
        const toolCallId = String(update['toolCallId'] ?? '');
        const state = record.toolCalls.get(toolCallId) ?? {};
        if (typeof update['title'] === 'string') state.title = update['title'];
        if (update['rawInput'] !== undefined) state.rawInput = update['rawInput'];
        record.toolCalls.set(toolCallId, state);
        const status = update['status'];
        if (status !== 'completed' && status !== 'failed') return;
        this.flush(record);
        const content = Array.isArray(update['content']) ? update['content'] : [];
        this.publish(record, status === 'failed' ? 'session.tool_error' : 'session.tool_result', {
          toolCallId,
          name: state.title ?? state.kind ?? 'tool',
          isError: status === 'failed',
          content: bounded(content.map(toolContentText).filter(Boolean).join('\n')),
        });
        for (const item of content as Array<Record<string, unknown>>) {
          if (item['type'] !== 'diff' || typeof item['path'] !== 'string') continue;
          this.publish(record, 'session.file_changed', {
            path: toPosix(
              isAbsolute(item['path']) ? relative(record.projectRoot, item['path']) : item['path'],
            ),
            changeType:
              item['oldText'] === null || item['oldText'] === undefined ? 'created' : 'modified',
            source: 'acp',
          });
        }
        return;
      }
      case 'plan': {
        this.flush(record);
        const entries = (Array.isArray(update['entries']) ? update['entries'] : []) as Array<{
          content?: string;
          status?: string;
        }>;
        this.publish(record, 'session.thinking', {
          content: entries
            .map((entry) => `[${entry.status ?? 'pending'}] ${entry.content ?? ''}`)
            .join('\n'),
          plan: entries,
        });
        return;
      }
      default:
        return;
    }
  }

  /** Streamed text arrives in fragments; it is published in readable pieces. */
  private append(record: AcpSession, role: 'assistant' | 'thinking', text: string): void {
    if (!text) return;
    if (record.buffer && record.buffer.role !== role) this.flush(record);
    record.buffer = { role, text: (record.buffer?.text ?? '') + text };
    if (record.buffer.text.length >= FLUSH_CHARS) this.flush(record);
    else {
      if (record.flushTimer) clearTimeout(record.flushTimer);
      record.flushTimer = setTimeout(() => this.flush(record), FLUSH_IDLE_MS);
      record.flushTimer.unref?.();
    }
  }

  private flush(record: AcpSession): void {
    if (record.flushTimer) clearTimeout(record.flushTimer);
    record.flushTimer = undefined;
    const buffer = record.buffer;
    record.buffer = null;
    if (!buffer?.text) return;
    if (buffer.role === 'assistant') {
      record.lastAssistantText = buffer.text;
      this.publish(record, 'session.message', { role: 'assistant', content: buffer.text });
    } else this.publish(record, 'session.thinking', { content: buffer.text });
  }

  // --------------------------------------------------------- helpers

  private publish(
    record: AcpSession,
    eventType: EventType,
    payload: Record<string, unknown>,
  ): void {
    const envelope: EventEnvelope = {
      eventId: generateEventId(),
      eventType,
      eventVersion: 1,
      sessionId: record.id,
      sequence: record.sequence++,
      occurredAt: new Date(),
      payload,
    };
    record.session.sequenceNumber = record.sequence;
    record.stream.publish(envelope);
  }

  private fail(
    record: AcpSession,
    error: string,
    eventType: 'session.failed' | 'session.crashed' = 'session.failed',
    extra: Record<string, unknown> = {},
  ): void {
    if (record.ended) return;
    record.ended = eventType === 'session.crashed';
    record.state = eventType === 'session.crashed' ? 'crashed' : 'failed';
    record.session.state = record.state;
    record.session.endTime = new Date();
    record.session.error = {
      code: 'ACP_SESSION_FAILED',
      message: error,
      fatal: true,
      retryable: true,
    };
    this.publish(record, eventType, { error, ...extra });
  }

  private answerAllPermissions(record: AcpSession, outcome: unknown): void {
    for (const [approvalId, pending] of record.permissions) {
      clearTimeout(pending.timer);
      pending.resolve(outcome);
      record.permissions.delete(approvalId);
    }
  }

  private stopProcess(record: AcpSession): void {
    record.connection.close('Session ended');
    if (record.child.exitCode === null && !record.child.killed) record.child.kill();
  }

  private locate(): { resolved: ResolvedCommand; args: string[] } | null {
    for (const candidate of this.preset.commands) {
      const resolved = this.options.locate
        ? this.options.locate(candidate.command)
        : findCommand(
            candidate.command,
            this.options.env ?? process.env,
            this.options.platform ?? process.platform,
          );
      if (resolved) return { resolved, args: candidate.args ?? [] };
    }
    return null;
  }

  private requireSession(sessionId: string): AcpSession {
    const record = this.sessions.get(sessionId);
    if (!record) throw new Error(`Unknown ACP session: ${sessionId}`);
    return record;
  }
}

// ------------------------------------------------------------ pure helpers

/** What a tool call does, in the terms the Control Plane scores. */
export function describeAction(
  call: ToolCallState,
  content: unknown,
  projectRoot: string,
): { capability: Capability; command?: string; resource?: string } {
  const raw = (call.rawInput && typeof call.rawInput === 'object' ? call.rawInput : {}) as Record<
    string,
    unknown
  >;
  const diffPath = Array.isArray(content)
    ? (content as Array<Record<string, unknown>>).find((item) => item['type'] === 'diff')?.['path']
    : undefined;
  const path = firstString(
    call.locations?.[0]?.path,
    raw['path'],
    raw['file_path'],
    raw['filePath'],
    raw['abs_path'],
    diffPath,
  );
  const resource = path ? toPosix(isAbsolute(path) ? path : join(projectRoot, path)) : undefined;
  const command = commandOf(raw['command'] ?? raw['cmd'] ?? raw['commands']);

  switch (call.kind) {
    case 'execute':
      return { capability: 'process.exec', ...(command ? { command } : {}) };
    case 'edit':
    case 'move':
      return { capability: 'filesystem.write', ...(resource ? { resource } : {}) };
    case 'delete':
      return { capability: 'filesystem.delete', ...(resource ? { resource } : {}) };
    case 'read':
    case 'search':
      return { capability: 'filesystem.read', ...(resource ? { resource } : {}) };
    case 'fetch': {
      const url = firstString(raw['url'], raw['uri']);
      return { capability: 'network.access', ...(url ? { resource: url } : {}) };
    }
    default:
      return command
        ? { capability: 'process.exec', command }
        : resource
          ? { capability: 'filesystem.write', resource }
          : { capability: 'process.exec' };
  }
}

/** A command as a string; `["bash", "-lc", "ls"]` is the `ls` it runs. */
function commandOf(value: unknown): string | undefined {
  if (typeof value === 'string') return value.trim() || undefined;
  if (Array.isArray(value) && value.every((part) => typeof part === 'string')) {
    const parts = value;
    if (
      parts.length >= 3 &&
      /(^|[\\/])(ba|z|da)?sh$/.test(parts[0]!) &&
      /^-[a-z]*c$/.test(parts[1]!)
    )
      return parts.slice(2).join(' ');
    return parts.join(' ') || undefined;
  }
  return undefined;
}

/** "Allow once" or "reject once" — never "always": Odysseus remembers approvals itself. */
export function chooseOutcome(options: PermissionOption[], approved: boolean): unknown {
  const kinds = approved ? ['allow_once', 'allow'] : ['reject_once', 'reject', 'deny'];
  const byKind = (kind: string) => options.find((option) => option.kind === kind);
  const choice =
    kinds.map(byKind).find(Boolean) ??
    (approved
      ? options.find((option) => option.kind?.startsWith('allow') && option.kind !== 'allow_always')
      : options.find((option) => /^(reject|deny)/.test(option.kind ?? '')));
  return choice
    ? { outcome: { outcome: 'selected', optionId: choice.optionId } }
    : { outcome: { outcome: 'cancelled' } };
}

function contentText(block: unknown): string {
  if (!block || typeof block !== 'object') return '';
  const value = block as Record<string, unknown>;
  if (value['type'] === 'text' && typeof value['text'] === 'string') return value['text'];
  if (value['type'] === 'resource_link' && typeof value['uri'] === 'string')
    return `[${value['uri']}]`;
  if (value['type'] === 'resource') {
    const resource = value['resource'] as { text?: unknown; uri?: unknown } | undefined;
    return typeof resource?.text === 'string'
      ? resource.text
      : `[${String(resource?.uri ?? 'resource')}]`;
  }
  return value['type'] ? `[${String(value['type'])}]` : '';
}

function toolContentText(item: unknown): string {
  if (!item || typeof item !== 'object') return '';
  const value = item as Record<string, unknown>;
  if (value['type'] === 'content') return contentText(value['content']);
  if (value['type'] === 'diff') return `Edited ${String(value['path'])}`;
  if (value['type'] === 'terminal') return `[terminal ${String(value['terminalId'])}]`;
  return '';
}

function bounded(text: string): string {
  return text.length > MAX_TOOL_OUTPUT_CHARS ? `${text.slice(0, MAX_TOOL_OUTPUT_CHARS)}…` : text;
}

function firstString(...values: unknown[]): string | undefined {
  for (const value of values) if (typeof value === 'string' && value.trim()) return value.trim();
  return undefined;
}

function toPosix(path: string): string {
  return path.split(sep).join('/');
}

function keep(lines: string[], line: string): void {
  lines.push(line.slice(0, 500));
  if (lines.length > 50) lines.shift();
}

/** A path with symlinks resolved, including one to a file that does not exist yet. */
function resolveReal(path: string): string {
  const missing: string[] = [];
  let current = path;
  while (!existsSync(current)) {
    const parent = dirname(current);
    if (parent === current) break;
    missing.unshift(current.slice(parent.length).replace(/^[\\/]+/, ''));
    current = parent;
  }
  return join(realOrSelf(current), ...missing);
}

function realOrSelf(path: string): string {
  try {
    return realpathSync.native(path);
  } catch {
    return path;
  }
}

/**
 * The command on PATH, without a shell. Windows npm shims are unwrapped by
 * `resolveCommand`, so the prompt is never parsed by cmd.exe.
 */
export function findCommand(
  name: string,
  env: NodeJS.ProcessEnv,
  platform: NodeJS.Platform,
): ResolvedCommand | null {
  if (platform === 'win32') {
    const resolved = resolveCommand(name, { env, platform });
    return resolved.command === name && !isAbsolute(name) ? null : resolved;
  }
  if (isAbsolute(name)) return existsSync(name) ? { command: name, prefixArgs: [] } : null;
  for (const directory of (env['PATH'] ?? '').split(delimiter).filter(Boolean)) {
    const candidate = join(directory, name);
    try {
      if (statSync(candidate).isFile()) return { command: candidate, prefixArgs: [] };
    } catch {
      /* not here */
    }
  }
  return null;
}
