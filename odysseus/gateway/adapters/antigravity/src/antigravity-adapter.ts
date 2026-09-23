import { execFile } from 'node:child_process';
import { once } from 'node:events';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { createInterface } from 'node:readline';
import { promisify } from 'node:util';

import type {
  AgentAdapter,
  AgentInstallationResult,
  AgentMetadata,
  AgentValidationResult,
  ApprovalAction,
  EventType,
  EventStream,
  EventSubscriber,
  Sandbox,
  SandboxManager,
  Session,
  SessionConfig,
  SessionState,
} from '@odysseus/protocol';
import { generateSessionId } from '@odysseus/protocol';
import { SandboxManager as LocalSandboxManager } from '@odysseus/sandbox';

import { AntigravityEventStream } from './event-stream';
import { safeGitDiff } from './safe-git';
import { AntigravityStreamParser } from './stream-parser';

const execFileAsync = promisify(execFile);
const MAX_PROMPT_CHARS = 100_000;

interface Entry {
  sandbox: Sandbox;
  root: string;
  stream: AntigravityEventStream;
  parser: AntigravityStreamParser;
  session: Session;
  conversationId?: string;
  ready: boolean;
  activeTurn: boolean;
  queuedPrompts: string[];
  stderr: string[];
  stopping: boolean;
}

export class AntigravityAdapter implements AgentAdapter {
  private readonly sessions = new Map<string, Entry>();
  private version = 'unknown';

  constructor(
    private readonly sandboxes: SandboxManager = new LocalSandboxManager(),
    private readonly binary = resolveAntigravityBinary(),
  ) {}

  metadata(): AgentMetadata {
    return {
      id: 'antigravity',
      name: 'Google Antigravity',
      version: this.version,
      platform: ['linux', 'darwin', 'win32'],
      capabilities: {
        sessionCreation: 'supported',
        promptDelivery: 'supported',
        streaming: 'supported',
        cancellation: 'supported',
        diffCollection: 'supported',
        // agy 1.1.27 exposes request-review internally, but no documented
        // external decision callback. Odysseus must not claim it can enforce
        // a mid-turn policy decision that it cannot deliver to the CLI.
        approvalInterception: 'unsupported',
        checkpointRecovery: 'partial',
        multiTurn: 'supported',
        fileOperations: 'supported',
        toolExecution: 'supported',
      },
      description:
        'Antigravity 1.1.x stream-json adapter with persistent, stdin-driven multi-turn sessions. External approval interception is unavailable.',
      tags: ['google', 'antigravity', 'cli'],
    };
  }

  async installOrDetect(): Promise<AgentInstallationResult> {
    try {
      const { stdout } = await execFileAsync(this.binary, ['--version'], {
        windowsHide: true,
        timeout: 5_000,
      });
      this.version = stdout.trim().split(/\s+/).at(-1) ?? 'unknown';
      return { success: true, installedVersion: this.version, path: this.binary };
    } catch {
      return {
        success: false,
        error: {
          code: 'ANTIGRAVITY_NOT_FOUND',
          message: 'Antigravity CLI (agy) was not found on PATH',
          retryable: true,
        },
      };
    }
  }

  async validateEnvironment(): Promise<AgentValidationResult> {
    const installation = await this.installOrDetect();
    if (!installation.success) {
      return {
        valid: false,
        errors: [installation.error!.message],
        warnings: ['Install agy and sign in through Antigravity before use.'],
        checks: { binary_present: false, stream_json_supported: false },
      };
    }

    try {
      const { stdout, stderr } = await execFileAsync(this.binary, ['--help'], {
        windowsHide: true,
        timeout: 5_000,
        maxBuffer: 2 * 1024 * 1024,
      });
      const help = `${stdout}\n${stderr}`;
      const streamJson =
        help.includes('--input-format') &&
        help.includes('--output-format') &&
        help.includes('stream-json');
      const sandbox = help.includes('--sandbox');
      return {
        valid: streamJson && sandbox,
        errors: [
          ...(!streamJson ? ['Installed agy does not expose bidirectional stream-json mode'] : []),
          ...(!sandbox ? ['Installed agy does not expose its sandbox flag'] : []),
        ],
        warnings: [
          'agy has no non-interactive authentication-status command; credentials are verified by the first live turn.',
          'External approval interception is unavailable; approvalMode “ask” is rejected before launch.',
        ],
        checks: {
          binary_present: true,
          stream_json_supported: streamJson,
          cli_sandbox_supported: sandbox,
          credentials_status_reportable: false,
        },
      };
    } catch (error) {
      return {
        valid: false,
        errors: [
          `Could not inspect Antigravity CLI capabilities: ${
            error instanceof Error ? error.message : String(error)
          }`,
        ],
        warnings: [],
        checks: { binary_present: true, stream_json_supported: false },
      };
    }
  }

  async startSession(config: SessionConfig): Promise<string> {
    const profile = config.sandbox?.profile ?? 'standard';
    const sandbox = await this.sandboxes.create({
      projectRoot: config.projectRoot,
      agentBinary: this.binary,
      agentArgs: buildAntigravityArgs(config),
      env: config.env ?? {},
      resourceLimits: config.resourceLimits ?? {},
      // The provider connection needs outbound access. Antigravity's own
      // --sandbox remains enabled for terminal restrictions.
      networkPolicy: { mode: 'allow-all' },
      writablePaths: profile === 'strict' ? [] : [config.projectRoot],
      readablePaths: [config.projectRoot],
      deniedPaths: [],
      profile,
      labels: { adapter: 'antigravity', externalApprovals: 'unsupported' },
    });

    const id = generateSessionId();
    const stream = new AntigravityEventStream();
    const session: Session = {
      id,
      projectId: String(config.metadata?.['projectId'] ?? config.projectRoot),
      adapterId: 'antigravity',
      state: 'initializing',
      processId: sandbox.pid,
      sandboxId: sandbox.id,
      startTime: new Date(),
      sequenceNumber: 0,
      metadata: {
        ...(config.metadata ?? {}),
        projectRoot: config.projectRoot,
        ...(config.model ? { model: config.model } : {}),
      },
    };
    const entry: Entry = {
      sandbox,
      root: config.projectRoot,
      stream,
      parser: new AntigravityStreamParser(id),
      session,
      ready: false,
      activeTurn: false,
      queuedPrompts: [],
      stderr: [],
      stopping: false,
    };
    this.sessions.set(id, entry);
    this.watch(entry);
    if (config.prompt?.trim()) await this.enqueuePrompt(entry, config.prompt);
    return id;
  }

  async sendMessage(id: string, message: string): Promise<void> {
    await this.enqueuePrompt(this.entry(id), message);
  }

  async sendInput(id: string, data: string): Promise<void> {
    await this.sendMessage(id, data);
  }

  streamEvents(id: string, subscriber?: Partial<EventSubscriber>): EventStream {
    const stream = this.entry(id).stream;
    if (subscriber) stream.subscribe(subscriber);
    return stream;
  }

  async requestApproval(
    _id: string,
    action: ApprovalAction,
  ): Promise<{ approved: boolean; reason?: string }> {
    return {
      approved: false,
      reason: `Antigravity CLI has no external approval-decision callback for ${action.type}.`,
    };
  }

  async submitApprovalDecision(
    _id: string,
    approvalId: string,
    _approved: boolean,
    _reason?: string,
  ): Promise<void> {
    throw new Error(`Antigravity has no externally pending approval ${approvalId}`);
  }

  async abortSession(id: string, reason: string, force = false): Promise<void> {
    const entry = this.entry(id);
    entry.stopping = true;
    entry.queuedPrompts.length = 0;
    entry.session.state = 'cancelled';
    entry.session.endTime = new Date();
    this.publish(entry, 'session.cancelled', { reason, force });
    if (force) await entry.sandbox.kill('SIGKILL');
    else await entry.sandbox.stop();
    entry.stream.unsubscribe();
  }

  async collectDiff(id: string): Promise<string> {
    return safeGitDiff(this.entry(id).root);
  }

  async getState(id: string): Promise<SessionState> {
    return this.entry(id).session.state;
  }

  async getSession(id: string): Promise<Session | undefined> {
    return this.sessions.get(id)?.session;
  }

  async checkpointSession(id: string): Promise<string> {
    const conversationId = this.entry(id).conversationId;
    if (!conversationId) throw new Error('Antigravity session has no conversation id yet');
    return conversationId;
  }

  async cleanupSession(id: string): Promise<void> {
    const entry = this.sessions.get(id);
    if (!entry) return;
    entry.stopping = true;
    entry.queuedPrompts.length = 0;
    await this.sandboxes.destroy(entry.sandbox.id);
    entry.stream.unsubscribe();
    this.sessions.delete(id);
  }

  async shutdown(): Promise<void> {
    await Promise.all([...this.sessions.keys()].map((id) => this.cleanupSession(id)));
  }

  private entry(id: string): Entry {
    const entry = this.sessions.get(id);
    if (!entry) throw new Error(`Antigravity session not found: ${id}`);
    return entry;
  }

  private async enqueuePrompt(entry: Entry, prompt: string): Promise<void> {
    const message = prompt.trim();
    if (!message) throw new Error('Antigravity prompt cannot be empty');
    if (message.length > MAX_PROMPT_CHARS)
      throw new Error(`Antigravity prompt exceeds ${MAX_PROMPT_CHARS} characters`);
    if (['failed', 'cancelled', 'completed', 'crashed'].includes(entry.session.state))
      throw new Error(
        `Session ${entry.session.id} is ${entry.session.state}; cannot send a message`,
      );
    entry.queuedPrompts.push(message);
    await this.flushNextPrompt(entry);
  }

  private async flushNextPrompt(entry: Entry): Promise<void> {
    if (!entry.ready || entry.activeTurn || entry.stopping) return;
    const prompt = entry.queuedPrompts.shift();
    if (!prompt) return;
    entry.activeTurn = true;
    entry.session.state = 'running';
    try {
      if (
        !entry.sandbox.stdin.write(
          `${JSON.stringify({ event: 'user', message: { content: prompt } })}\n`,
        )
      )
        await once(entry.sandbox.stdin, 'drain');
      this.publish(entry, 'session.message', { role: 'user', content: prompt });
    } catch (error) {
      entry.activeTurn = false;
      entry.session.state = 'failed';
      entry.session.endTime = new Date();
      this.publish(entry, 'session.failed', {
        errorCode: 'ANTIGRAVITY_STDIN_FAILED',
        errorMessage: error instanceof Error ? error.message : String(error),
        fatal: true,
        durationMs: Date.now() - entry.session.startTime.getTime(),
      });
      throw error;
    }
  }

  private watch(entry: Entry): void {
    const stdout = createInterface({ input: entry.sandbox.stdout });
    stdout.on('line', (line) => {
      const parsed = entry.parser.parseLine(line);
      let becameReady = false;
      if (parsed.conversationId) {
        entry.conversationId = parsed.conversationId;
        entry.session.metadata['conversationId'] = parsed.conversationId;
      }
      for (const event of parsed.envelopes) {
        entry.session.sequenceNumber = Math.max(entry.session.sequenceNumber, event.sequence);
        entry.session.lastEventAt = event.occurredAt;
        if (event.eventType === 'session.started') {
          entry.session.state = 'running';
          entry.ready = true;
          becameReady = true;
        }
        if (event.eventType === 'session.failed') {
          entry.session.state = 'failed';
          entry.session.endTime = new Date();
        }
        entry.stream.publish(event);
      }
      if (becameReady) void this.flushNextPrompt(entry).catch(() => undefined);
      if (parsed.terminal) {
        entry.activeTurn = false;
        if (!parsed.error && !entry.stopping) {
          entry.session.state = 'running';
          void this.flushNextPrompt(entry).catch(() => undefined);
        } else {
          entry.queuedPrompts.length = 0;
        }
      }
    });

    createInterface({ input: entry.sandbox.stderr }).on('line', (line) => {
      if (entry.stderr.length < 40) entry.stderr.push(line);
      this.publish(entry, 'session.output', {
        stream: 'stderr',
        content: line,
        timestamp: new Date(),
      });
    });

    void entry.sandbox.waitForExit().then(({ exitCode, signal }) => {
      if (entry.stopping || entry.session.state === 'failed') return;
      entry.session.state = 'crashed';
      entry.session.endTime = new Date();
      this.publish(entry, 'session.crashed', {
        exitCode,
        signal,
        errorMessage:
          entry.stderr.join('\n') || 'Antigravity CLI exited before the session was stopped',
      });
      entry.stream.unsubscribe();
    });
  }

  private publish(entry: Entry, eventType: EventType, payload: unknown): void {
    const event = entry.parser.createEvent(eventType, payload);
    entry.session.sequenceNumber = event.sequence;
    entry.session.lastEventAt = event.occurredAt;
    entry.stream.publish(event);
  }
}

export function buildAntigravityArgs(config: SessionConfig): string[] {
  const profile = config.sandbox?.profile ?? 'standard';
  const mode = config.approvalMode === 'never' || profile === 'strict' ? 'plan' : 'accept-edits';
  const args = [
    '--input-format',
    'stream-json',
    '--output-format',
    'stream-json',
    '--mode',
    mode,
    '--sandbox',
    '--disable-slash-commands',
  ];
  if (config.model) args.push('--model', config.model);
  const effort = config.metadata?.['effort'];
  if (effort === 'low' || effort === 'medium' || effort === 'high') args.push('--effort', effort);
  const timeoutMs = config.timeout ?? config.resourceLimits?.timeoutMs;
  if (timeoutMs && Number.isFinite(timeoutMs) && timeoutMs > 0)
    args.push('--print-timeout', `${Math.max(1, Math.ceil(timeoutMs / 1000))}s`);
  return args;
}

function resolveAntigravityBinary(): string {
  if (process.env.ANTIGRAVITY_BINARY) return process.env.ANTIGRAVITY_BINARY;
  const localInstall = process.env.LOCALAPPDATA
    ? join(process.env.LOCALAPPDATA, 'agy', 'bin', 'agy.exe')
    : undefined;
  return localInstall && existsSync(localInstall) ? localInstall : 'agy';
}
