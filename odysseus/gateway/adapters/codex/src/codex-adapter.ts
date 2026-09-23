import type {
  AgentAdapter,
  AgentInstallationResult,
  AgentMetadata,
  AgentValidationResult,
  ApprovalAction,
  EventStream,
  EventSubscriber,
  Session,
  SessionConfig,
  SessionState,
} from '@odysseus/protocol';
import { generateSessionId } from '@odysseus/protocol';
import { AdapterEventStream } from './event-stream';
import { safeGitDiff } from './safe-git';
import { CodexProcessManager, type CodexProcessController } from './process-manager';
import { CodexStreamParser } from './stream-parser';

interface Record {
  id: string;
  root: string;
  config: SessionConfig;
  stream: AdapterEventStream;
  parser: CodexStreamParser;
  state: SessionState;
  session: Session;
  threadId: string | undefined;
  current: ReturnType<CodexProcessController['run']> | undefined;
  turn: Promise<void> | undefined;
}

export class CodexAdapter implements AgentAdapter {
  private readonly sessions = new Map<string, Record>();
  private detectedVersion = 'unknown';
  constructor(private readonly processes: CodexProcessController = new CodexProcessManager()) {}
  metadata(): AgentMetadata {
    return {
      id: 'codex',
      name: 'OpenAI Codex',
      version: this.detectedVersion,
      platform: ['linux', 'darwin', 'win32'],
      capabilities: {
        sessionCreation: 'supported',
        promptDelivery: 'supported',
        streaming: 'supported',
        cancellation: 'supported',
        diffCollection: 'partial',
        approvalInterception: 'unsupported',
        checkpointRecovery: 'partial',
        multiTurn: 'supported',
        fileOperations: 'supported',
        toolExecution: 'supported',
      },
      description:
        'OpenAI Codex CLI via codex exec --json; follow-up messages use codex exec resume.',
      homepage: 'https://developers.openai.com/codex/cli/reference/',
      tags: ['openai', 'codex', 'cli'],
    };
  }
  async installOrDetect(): Promise<AgentInstallationResult> {
    const found = await this.processes.detect();
    if (!found)
      return {
        success: false,
        error: {
          code: 'CODEX_NOT_FOUND',
          message: 'Codex CLI was not found on PATH.',
          retryable: true,
        },
      };
    this.detectedVersion = found.version;
    return { success: true, installedVersion: found.version, path: found.path };
  }
  async validateEnvironment(): Promise<AgentValidationResult> {
    const validation = await this.processes.validate();
    if (validation.version) this.detectedVersion = validation.version;
    return {
      valid: validation.valid,
      errors: validation.errors,
      warnings: validation.warnings,
      checks: {
        binary_present: validation.version !== undefined,
        credentials_present: validation.valid,
      },
    };
  }
  async startSession(config: SessionConfig): Promise<string> {
    if (!(await this.processes.detect())) throw new Error('Codex CLI is not installed');
    const id = generateSessionId();
    const stream = new AdapterEventStream();
    const session: Session = {
      id,
      projectId: config.projectRoot,
      adapterId: 'codex',
      state: 'initializing',
      startTime: new Date(),
      sequenceNumber: 0,
      metadata: { projectRoot: config.projectRoot, model: config.model },
    };
    const record: Record = {
      id,
      root: config.projectRoot,
      config,
      stream,
      parser: new CodexStreamParser(id),
      state: 'initializing',
      session,
      threadId: undefined,
      current: undefined,
      turn: undefined,
    };
    this.sessions.set(id, record);
    if (config.prompt) record.turn = this.runTurn(record, config.prompt);
    else {
      record.state = 'running';
      session.state = 'running';
    }
    return id;
  }
  private async runTurn(record: Record, prompt: string): Promise<void> {
    const run = this.processes.run({
      prompt,
      projectRoot: record.root,
      config: record.config,
      ...(record.threadId ? { threadId: record.threadId } : {}),
    });
    record.current = run;
    let terminal = false;
    const errors: string[] = [];
    const stdout = new Promise<void>((resolve) =>
      this.processes.watchStdout(
        run.child,
        (line) => {
          const parsed = record.parser.parseLine(line);
          if (parsed.threadId) record.threadId = parsed.threadId;
          parsed.envelopes.forEach((event) => record.stream.publish(event));
          if (parsed.terminal) {
            terminal = true;
            record.state = parsed.error ? 'failed' : 'running';
            record.session.state = record.state;
          } else if (record.state === 'initializing') {
            record.state = 'running';
            record.session.state = 'running';
          }
        },
        resolve,
      ),
    );
    this.processes.watchStderr(run.child, (line) => {
      if (errors.length < 40) errors.push(line);
    });
    const [code] = await Promise.all([run.exited, stdout]);
    record.current = undefined;
    if (!terminal) {
      const error = errors.join('\n') || `codex exited with code ${String(code)}`;
      record.state = 'failed';
      record.session.state = 'failed';
      record.stream.publish({
        eventId: `evt_${Date.now()}`,
        eventType: 'session.failed',
        eventVersion: 1,
        sessionId: record.id,
        sequence: Number.MAX_SAFE_INTEGER,
        occurredAt: new Date(),
        payload: { error, exitCode: code },
      } as never);
    }
    if (record.state === 'failed') record.session.endTime = new Date();
  }
  async sendMessage(id: string, message: string): Promise<void> {
    const record = this.require(id);
    if (record.turn) await record.turn.catch(() => undefined);
    if (record.state === 'failed' || record.state === 'cancelled')
      throw new Error(`Session ${id} is ${record.state}; cannot send a message`);
    record.state = 'running';
    record.session.state = 'running';
    record.turn = this.runTurn(record, message);
  }
  async sendInput(id: string, data: string) {
    return this.sendMessage(id, data);
  }
  streamEvents(id: string, subscriber?: Partial<EventSubscriber>): EventStream {
    const record = this.require(id);
    if (subscriber) record.stream.subscribe(subscriber);
    return record.stream;
  }
  async requestApproval(_id: string, action: ApprovalAction) {
    return {
      approved: false,
      reason: `Codex exec does not expose external mid-turn approval interception for ${action.type}.`,
    };
  }
  async submitApprovalDecision(_id: string, approvalId: string): Promise<void> {
    throw new Error(`Codex has no externally pending approval ${approvalId}`);
  }
  async abortSession(id: string, reason: string, force = false): Promise<void> {
    const record = this.require(id);
    if (record.current) await this.processes.stop(record.current.child, force);
    record.state = 'cancelled';
    record.session.state = 'cancelled';
    record.session.endTime = new Date();
    record.session.error = {
      code: 'CODEX_ABORTED',
      message: reason,
      fatal: false,
      retryable: true,
    };
    record.stream.publish({
      eventId: `evt_${Date.now()}_cancel`,
      eventType: 'session.cancelled',
      eventVersion: 1,
      sessionId: id,
      sequence: Number.MAX_SAFE_INTEGER - 1,
      occurredAt: new Date(),
      payload: { reason, force },
    } as never);
  }
  async collectDiff(id: string) {
    return safeGitDiff(this.require(id).root);
  }
  async getState(id: string) {
    return this.require(id).state;
  }
  async getSession(id: string) {
    return this.sessions.get(id)?.session;
  }
  async cleanupSession(id: string) {
    const record = this.sessions.get(id);
    if (!record) return;
    if (record.current) await this.processes.stop(record.current.child, true);
    record.stream.close();
    this.sessions.delete(id);
  }
  async checkpointSession(id: string) {
    const threadId = this.require(id).threadId;
    if (!threadId) throw new Error('Codex session has no thread id');
    return threadId;
  }
  async shutdown() {
    await Promise.all([...this.sessions.keys()].map((id) => this.cleanupSession(id)));
  }
  private require(id: string) {
    const record = this.sessions.get(id);
    if (!record) throw new Error(`Unknown Codex session: ${id}`);
    return record;
  }
}
