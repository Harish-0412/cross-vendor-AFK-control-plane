import type {
  AgentAdapter,
  AgentInstallationResult,
  AgentValidationResult,
  ApprovalAction,
  EventStream,
  EventSubscriber,
  Session,
  SessionConfig,
  SessionState,
} from '@freebuff/protocol';
import { generateSessionId } from '@freebuff/protocol';

import { opencodeMetadata } from './capabilities';
import { AdapterEventStream } from './event-stream';
import { OpenCodeOutputParser } from './output-parser';
import { OpenCodeProcessManager, type OpenCodeProcessController } from './process-manager';
import { safeGitDiff } from './safe-git';
import type { OpenCodeProcessOptions } from './types';

interface OpenCodeSession {
  sandboxId: string;
  projectRoot: string;
  stream: AdapterEventStream;
  state: SessionState;
  session: Session;
}

export class OpenCodeAdapter implements AgentAdapter {
  private readonly sessions = new Map<string, OpenCodeSession>();
  private readonly processManager: OpenCodeProcessController;
  private detectedVersion = 'unknown';

  constructor(processManager?: OpenCodeProcessController, options?: OpenCodeProcessOptions) {
    this.processManager = processManager ?? new OpenCodeProcessManager(undefined, options);
  }

  metadata() {
    return opencodeMetadata(this.detectedVersion);
  }

  async installOrDetect(): Promise<AgentInstallationResult> {
    const detected = await this.processManager.detect();
    if (!detected)
      return {
        success: false,
        error: {
          code: 'OPENCODE_NOT_FOUND',
          message: 'OpenCode CLI was not found on PATH',
          retryable: true,
        },
      };
    this.detectedVersion = detected.version;
    return { success: true, installedVersion: detected.version, path: detected.path };
  }

  async validateEnvironment(): Promise<AgentValidationResult> {
    const result = await this.processManager.validate();
    if (result.version) this.detectedVersion = result.version;
    return {
      valid: result.valid,
      errors: result.errors,
      warnings: result.valid
        ? []
        : ['Install OpenCode and authenticate a provider before creating a session.'],
      checks: { binary_present: result.valid, version_supported: result.valid },
    };
  }

  async startSession(config: SessionConfig): Promise<string> {
    if (!config.prompt)
      throw new Error('OpenCode requires SessionConfig.prompt for a new run session');
    const sandbox = await this.processManager.start(config);
    const id = generateSessionId();
    const stream = new AdapterEventStream();
    const session: Session = {
      id,
      projectId: String(config.metadata?.['projectId'] ?? 'proj_opencode'),
      adapterId: 'opencode',
      state: 'running',
      processId: sandbox.pid,
      sandboxId: sandbox.id,
      startTime: new Date(),
      sequenceNumber: 0,
      metadata: { ...(config.metadata ?? {}) },
    };
    const internal: OpenCodeSession = {
      sandboxId: sandbox.id,
      projectRoot: config.projectRoot,
      stream,
      state: 'running',
      session,
    };
    this.sessions.set(id, internal);
    const parser = new OpenCodeOutputParser(
      id,
      typeof config.metadata?.['deviceId'] === 'string' ? config.metadata['deviceId'] : undefined,
    );
    this.processManager.watchStdout(
      sandbox,
      (line) => {
        for (const event of parser.parseLine(line)) {
          internal.session.sequenceNumber = event.sequence;
          internal.session.lastEventAt = event.occurredAt;
          if (event.eventType === 'session.completed')
            internal.state = internal.session.state = 'completed';
          if (event.eventType === 'session.failed')
            internal.state = internal.session.state = 'failed';
          internal.stream.publish(event);
        }
      },
      () => {
        if (internal.state === 'running') {
          internal.state = internal.session.state = 'completed';
        }
        internal.stream.close();
      },
    );
    return id;
  }

  async sendMessage(_sessionId: string, _message: string): Promise<void> {
    throw new Error('OpenCode multi-turn message delivery is not implemented in Subphase 8.2');
  }
  async sendInput(_sessionId: string, _data: string): Promise<void> {
    throw new Error('OpenCode stdin control is not implemented in Subphase 8.2');
  }
  streamEvents(sessionId: string, subscriber?: Partial<EventSubscriber>): EventStream {
    const session = this.requireSession(sessionId);
    if (subscriber) session.stream.subscribe(subscriber);
    return session.stream;
  }
  async requestApproval(
    _sessionId: string,
    _action: ApprovalAction,
  ): Promise<{ approved: boolean; reason?: string }> {
    throw new Error('OpenCode does not expose external approval interception');
  }
  async submitApprovalDecision(
    _sessionId: string,
    _approvalId: string,
    _approved: boolean,
    _reason?: string,
  ): Promise<void> {
    throw new Error('OpenCode does not expose external approval interception');
  }
  async abortSession(sessionId: string, _reason: string, force = false): Promise<void> {
    const session = this.requireSession(sessionId);
    const sandbox = this.requireSandbox(session.sandboxId);
    await this.processManager.stop(sandbox, force);
    session.state = session.session.state = 'cancelled';
    session.stream.close();
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
    const session = this.sessions.get(sessionId);
    if (!session) return;
    const sandbox = this.requireSandbox(session.sandboxId);
    await this.processManager.stop(sandbox, true);
    session.stream.close();
    this.sessions.delete(sessionId);
  }
  async shutdown(): Promise<void> {
    await Promise.all([...this.sessions.keys()].map((id) => this.cleanupSession(id)));
  }

  private requireSession(id: string): OpenCodeSession {
    const session = this.sessions.get(id);
    if (!session) throw new Error(`OpenCode session not found: ${id}`);
    return session;
  }
  private requireSandbox(id: string) {
    const sandbox = this.processManager.getSandbox(id);
    if (!sandbox) throw new Error(`Sandbox not found: ${id}`);
    return sandbox;
  }
}
