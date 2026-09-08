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
  EventStream,
  EventSubscriber,
  Sandbox,
  SandboxManager,
  Session,
  SessionConfig,
  SessionState,
} from '@freebuff/protocol';
import { generateSessionId } from '@freebuff/protocol';
import { SandboxManager as LocalSandboxManager } from '@freebuff/sandbox';

import { AntigravityEventStream } from './event-stream';
import { AntigravityStreamParser } from './stream-parser';

const execFileAsync = promisify(execFile);
interface Entry {
  sandbox: Sandbox;
  root: string;
  stream: AntigravityEventStream;
  session: Session;
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
      name: 'Antigravity CLI',
      version: this.version,
      platform: ['linux', 'darwin', 'win32'],
      capabilities: {
        sessionCreation: 'supported',
        promptDelivery: 'supported',
        streaming: 'supported',
        cancellation: 'supported',
        diffCollection: 'supported',
        approvalInterception: 'unsupported',
        checkpointRecovery: 'partial',
        multiTurn: 'supported',
        fileOperations: 'supported',
        toolExecution: 'supported',
      },
      description:
        'Antigravity stream-json adapter. CLI permission review cannot be delegated to an external policy callback.',
      tags: ['antigravity', 'cli', 'production'],
    };
  }
  async installOrDetect(): Promise<AgentInstallationResult> {
    try {
      const { stdout } = await execFileAsync(this.binary, ['--version'], {
        windowsHide: true,
        timeout: 5_000,
      });
      this.version = stdout.trim();
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
    return {
      valid: installation.success,
      errors: installation.success ? [] : [installation.error!.message],
      warnings: installation.success
        ? []
        : ['Install agy and authenticate interactively before use.'],
      checks: { binary_present: installation.success, stream_json_supported: installation.success },
    };
  }
  async startSession(config: SessionConfig): Promise<string> {
    if (!config.prompt) throw new Error('Antigravity requires SessionConfig.prompt');
    const sandbox = await this.sandboxes.create({
      projectRoot: config.projectRoot,
      agentBinary: this.binary,
      agentArgs: ['--input-format', 'stream-json', '--output-format', 'stream-json'],
      env: config.env ?? {},
      resourceLimits: config.resourceLimits ?? {},
      networkPolicy: { mode: 'allow-all' },
      writablePaths: [config.projectRoot],
      readablePaths: [config.projectRoot],
      deniedPaths: [],
      profile: config.sandbox?.profile ?? 'standard',
      labels: { adapter: 'antigravity' },
    });
    const id = generateSessionId();
    const stream = new AntigravityEventStream();
    const session: Session = {
      id,
      projectId: String(config.metadata?.['projectId'] ?? 'proj_antigravity'),
      adapterId: 'antigravity',
      state: 'running',
      processId: sandbox.pid,
      sandboxId: sandbox.id,
      startTime: new Date(),
      sequenceNumber: 0,
      metadata: { ...(config.metadata ?? {}) },
    };
    const entry = { sandbox, root: config.projectRoot, stream, session };
    this.sessions.set(id, entry);
    this.watch(id, entry);
    await this.writePrompt(entry, config.prompt);
    return id;
  }
  async sendMessage(id: string, message: string): Promise<void> {
    await this.writePrompt(this.entry(id), message);
  }
  async sendInput(id: string, data: string): Promise<void> {
    await this.writePrompt(this.entry(id), data);
  }
  streamEvents(id: string, subscriber?: Partial<EventSubscriber>): EventStream {
    const stream = this.entry(id).stream;
    if (subscriber) stream.subscribe(subscriber);
    return stream;
  }
  async requestApproval(
    _id: string,
    _action: ApprovalAction,
  ): Promise<{ approved: boolean; reason?: string }> {
    throw new Error('Antigravity CLI has no external approval-decision callback');
  }
  async submitApprovalDecision(
    _id: string,
    _approval: string,
    _approved: boolean,
    _reason?: string,
  ): Promise<void> {
    throw new Error('Antigravity CLI has no external approval-decision callback');
  }
  async abortSession(id: string, _reason: string, force = false): Promise<void> {
    const entry = this.entry(id);
    if (force) await entry.sandbox.kill('SIGTERM');
    else await entry.sandbox.stop();
    entry.session.state = 'cancelled';
    entry.stream.unsubscribe();
  }
  async collectDiff(id: string): Promise<string> {
    try {
      const { stdout } = await execFileAsync('git', ['diff', '--no-ext-diff', '--binary', '--'], {
        cwd: this.entry(id).root,
        windowsHide: true,
        timeout: 5_000,
        maxBuffer: 10 * 1024 * 1024,
      });
      return stdout;
    } catch (error) {
      throw new Error(
        `Unable to collect git diff: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }
  async getState(id: string): Promise<SessionState> {
    return this.entry(id).session.state;
  }
  async getSession(id: string): Promise<Session | undefined> {
    return this.sessions.get(id)?.session;
  }
  async cleanupSession(id: string): Promise<void> {
    const entry = this.sessions.get(id);
    if (!entry) return;
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
  private async writePrompt(entry: Entry, prompt: string): Promise<void> {
    if (
      !entry.sandbox.stdin.write(
        `${JSON.stringify({ event: 'user', message: { content: prompt } })}\n`,
      )
    )
      await once(entry.sandbox.stdin, 'drain');
  }
  private watch(id: string, entry: Entry): void {
    const parser = new AntigravityStreamParser(id);
    const lines = createInterface({ input: entry.sandbox.stdout });
    lines.on('line', (line) => {
      const event = parser.parse(line);
      if (!event) return;
      entry.session.sequenceNumber = event.sequence;
      if (event.eventType === 'session.completed') entry.session.state = 'completed';
      if (event.eventType === 'session.failed') entry.session.state = 'failed';
      entry.stream.publish(event);
    });
  }
}

function resolveAntigravityBinary(): string {
  if (process.env.ANTIGRAVITY_BINARY) return process.env.ANTIGRAVITY_BINARY;
  const localInstall = process.env.LOCALAPPDATA
    ? join(process.env.LOCALAPPDATA, 'agy', 'bin', 'agy.exe')
    : undefined;
  return localInstall && existsSync(localInstall) ? localInstall : 'agy';
}
