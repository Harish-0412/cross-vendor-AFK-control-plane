import { EventEmitter } from 'events';
import { v4 as uuidv4 } from 'uuid';
import { AgentConfig, Session, NormalizedEvent, AgentAdapter, HarnessResult } from '../types';
import { spawnProcess, waitForProcess, killProcess, ProcessHandle } from '../utils/process';
import { parseAgentOutput } from '../utils/events';
import { logger } from '../utils/logger';

export abstract class BaseAgentAdapter extends EventEmitter implements AgentAdapter {
  abstract readonly name: string;
  abstract readonly version: string;
  
  protected sessions: Map<string, Session> = new Map();
  protected processHandles: Map<string, ProcessHandle> = new Map();
  protected eventBuffers: Map<string, NormalizedEvent[]> = new Map();
  protected sequenceCounters: Map<string, number> = new Map();

  abstract detect(): Promise<boolean>;
  abstract getCommand(config: AgentConfig): { command: string; args: string[] };
  abstract parseEvent(line: string, sessionId: string, sequence: number): NormalizedEvent | null;
  abstract normalizeExitCode(code: number | null, signal: NodeJS.Signals | null): { success: boolean; status: Session['status'] };

  async start(config: AgentConfig): Promise<Session> {
    const sessionId = `sess_${uuidv4().replace(/-/g, '').slice(0, 12)}`;
    const { command, args } = this.getCommand(config);
    
    logger.info(`Starting ${this.name} session`, { sessionId, command, args });
    
    const handle = spawnProcess(command, args, {
      cwd: config.workspace,
      env: { ...process.env, ...config.env }
    });

    const session: Session = {
      id: sessionId,
      agent: this.name,
      pid: handle.pid,
      startTime: new Date(),
      status: 'starting',
      workspace: config.workspace,
      config
    };

    this.sessions.set(sessionId, session);
    this.processHandles.set(sessionId, handle);
    this.eventBuffers.set(sessionId, []);
    this.sequenceCounters.set(sessionId, 0);

    handle.stdoutEmitter.on('data', (data: string) => {
      this.handleStdout(sessionId, data);
    });

    handle.stderrEmitter.on('data', (data: string) => {
      logger.debug(`${this.name} stderr`, { sessionId, data: data.slice(0, 200) });
    });

    session.status = 'running';
    this.emit('session:started', session);
    
    return session;
  }

  private handleStdout(sessionId: string, data: string): void {
    const lines = data.split('\n');
    const buffer = this.eventBuffers.get(sessionId) || [];
    let sequence = this.sequenceCounters.get(sessionId) || 0;

    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed) continue;

      const event = this.parseEvent(trimmed, sessionId, sequence);
      if (event) {
        buffer.push(event);
        this.sequenceCounters.set(sessionId, ++sequence);
        this.emit('event', event);
      }
    }

    this.eventBuffers.set(sessionId, buffer);
  }

  async prompt(sessionId: string, message: string): Promise<void> {
    const handle = this.processHandles.get(sessionId);
    if (!handle) {
      throw new Error(`Session ${sessionId} not found`);
    }

    logger.debug(`Sending prompt to ${sessionId}`, { message: message.slice(0, 100) });
    
    handle.process.stdin?.write(`${message}\n`);
  }

  async captureOutput(sessionId: string): AsyncIterable<NormalizedEvent> {
    const buffer = this.eventBuffers.get(sessionId) || [];
    let index = 0;

    return {
      [Symbol.asyncIterator](): AsyncIterator<NormalizedEvent> {
        return {
          async next() {
            while (index < buffer.length) {
              return { value: buffer[index++], done: false };
            }
            
            await new Promise(resolve => setTimeout(resolve, 100));
            
            if (index < buffer.length) {
              return { value: buffer[index++], done: false };
            }
            
            const session = this.sessions.get(sessionId);
            if (!session || session.status !== 'running') {
              return { value: undefined, done: true };
            }
            
            return { value: undefined, done: false };
          },
          
          sessions: this.sessions
        } as any;
      }
    };
  }

  async followUp(sessionId: string, message: string): Promise<void> {
    return this.prompt(sessionId, message);
  }

  async stop(sessionId: string): Promise<HarnessResult> {
    const handle = this.processHandles.get(sessionId);
    const session = this.sessions.get(sessionId);
    const events = this.eventBuffers.get(sessionId) || [];
    
    if (!handle || !session) {
      throw new Error(`Session ${sessionId} not found`);
    }

    logger.info(`Stopping session ${sessionId}`);
    
    const result = await waitForProcess(handle, session.config.timeout || 30000);
    const { success, status } = this.normalizeExitCode(result.exitCode, result.signal);
    
    session.status = status;
    this.emit('session:ended', { session, result, events });
    
    this.cleanup(sessionId);
    
    return {
      session,
      events,
      rawEvents: [],
      exitCode: result.exitCode,
      duration: result.duration,
      success,
      error: success ? undefined : result.stderr || `Exit code: ${result.exitCode}`
    };
  }

  async kill(sessionId: string, signal: NodeJS.Signals = 'SIGINT'): Promise<void> {
    const handle = this.processHandles.get(sessionId);
    if (handle) {
      killProcess(handle, signal);
    }
  }

  getSession(sessionId: string): Session | undefined {
    return this.sessions.get(sessionId);
  }

  listSessions(): Session[] {
    return Array.from(this.sessions.values());
  }

  getEvents(sessionId: string): NormalizedEvent[] {
    return this.eventBuffers.get(sessionId) || [];
  }

  protected cleanup(sessionId: string): void {
    this.sessions.delete(sessionId);
    this.processHandles.delete(sessionId);
    this.eventBuffers.delete(sessionId);
    this.sequenceCounters.delete(sessionId);
  }

  async shutdown(): Promise<void> {
    const sessionIds = Array.from(this.sessions.keys());
    await Promise.all(sessionIds.map(id => this.kill(id, 'SIGKILL')));
    this.sessions.clear();
    this.processHandles.clear();
    this.eventBuffers.clear();
    this.sequenceCounters.clear();
  }
}