import { AgentConfig, NormalizedEvent, Session, MockAgentConfig } from '../types';
import { BaseAgentAdapter } from './base';
import { logger } from '../utils/logger';
import { v4 as uuidv4 } from 'uuid';

const SCENARIOS: Record<string, NormalizedEvent['eventType'][]> = {
  basic: [
    'session.started',
    'assistant.thinking',
    'assistant.message',
    'tool.call',
    'tool.result',
    'file.write',
    'assistant.message',
    'session.completed'
  ],
  'multi-turn': [
    'session.started',
    'assistant.thinking',
    'assistant.message',
    'tool.call',
    'tool.result',
    'file.write',
    'assistant.message',
    'user.message',
    'assistant.thinking',
    'assistant.message',
    'tool.call',
    'tool.result',
    'file.write',
    'assistant.message',
    'session.completed'
  ],
  approval: [
    'session.started',
    'assistant.thinking',
    'assistant.message',
    'tool.call',
    'approval.requested',
    'approval.granted',
    'tool.result',
    'file.write',
    'assistant.message',
    'session.completed'
  ],
  error: [
    'session.started',
    'assistant.thinking',
    'assistant.message',
    'tool.call',
    'tool.error',
    'assistant.message',
    'session.failed'
  ],
  crash: [
    'session.started',
    'assistant.thinking',
    'assistant.message',
    'tool.call',
    'tool.result',
    'file.write'
  ]
};

const EVENT_PAYLOADS: Record<NormalizedEvent['eventType'], any> = {
  'session.started': { workspace: '/tmp/test', model: 'mock-model' },
  'assistant.thinking': { phase: 'planning', thought: 'Analyzing the request...' },
  'assistant.message': { role: 'assistant', content: 'I will create a simple calculator function.' },
  'tool.call': { 
    id: 'call_123', 
    name: 'write_file', 
    arguments: { path: 'calculator.ts', content: 'export function add(a: number, b: number) { return a + b; }' } 
  },
  'tool.result': { toolCallId: 'call_123', output: 'File created successfully', success: true },
  'tool.error': { toolCallId: 'call_123', error: 'Permission denied', success: false },
  'file.write': { path: 'calculator.ts', operation: 'create', diff: '+ export function add(a: number, b: number) { return a + b; }' },
  'approval.requested': { tool: 'write_file', reason: 'Writing new file', risk: 'medium' },
  'approval.granted': { tool: 'write_file', grantedBy: 'user' },
  'session.completed': { summary: 'Created calculator function', turns: 3 },
  'session.failed': { error: 'Tool execution failed', turns: 2 },
  'session.cancelled': { reason: 'User cancelled' },
  'user.message': { role: 'user', content: 'Add unit tests' },
  'session.resumed': { previousSession: 'sess_prev' },
  'session.checkpoint': { turn: 5 },
  'metrics.usage': { inputTokens: 100, outputTokens: 50 }
};

export class MockAgentAdapter extends BaseAgentAdapter {
  readonly name = 'mock';
  readonly version = '0.1.0';
  
  private mockConfig: MockAgentConfig = { scenario: 'basic', delay: 100 };
  private eventGenerators: Map<string, AsyncGenerator<NormalizedEvent>> = new Map();

  async detect(): Promise<boolean> {
    return true;
  }

  configure(config: MockAgentConfig): void {
    this.mockConfig = { ...this.mockConfig, ...config };
  }

  getCommand(config: AgentConfig): { command: string; args: string[] } {
    return { command: 'mock', args: [] };
  }

  async start(config: AgentConfig): Promise<Session> {
    const sessionId = `sess_${uuidv4().replace(/-/g, '').slice(0, 12)}`;
    
    const session: Session = {
      id: sessionId,
      agent: this.name,
      pid: 0,
      startTime: new Date(),
      status: 'running',
      workspace: config.workspace,
      config
    };

    this.sessions.set(sessionId, session);
    this.eventBuffers.set(sessionId, []);
    this.sequenceCounters.set(sessionId, 0);

    const generator = this.createEventGenerator(sessionId);
    this.eventGenerators.set(sessionId, generator);

    this.runGenerator(sessionId, generator);
    
    this.emit('session:started', session);
    
    return session;
  }

  private createEventGenerator(sessionId: string): AsyncGenerator<NormalizedEvent> {
    const scenario = this.mockConfig.scenario;
    const events = SCENARIOS[scenario] || SCENARIOS.basic;
    const delay = this.mockConfig.delay || 100;
    let sequence = 0;
    let turn = 0;

    return (async function* () {
      for (const eventType of events) {
        if (this.mockConfig.crashAtTurn && turn >= this.mockConfig.crashAtTurn) {
          throw new Error('Simulated crash');
        }

        if (eventType === 'tool.call' || eventType === 'assistant.thinking') {
          turn++;
        }

        const payload = { ...EVENT_PAYLOADS[eventType] };
        
        if (eventType === 'assistant.message' && scenario === 'multi-turn') {
          payload.content = turn === 1 
            ? 'I will create a simple calculator function.'
            : 'I have added unit tests for the calculator.';
        }

        if (eventType === 'tool.call' && turn === 2) {
          payload.name = 'write_file';
          payload.arguments = { 
            path: 'calculator.test.ts', 
            content: 'import { add } from "./calculator"; test("add", () => expect(add(1,2)).toBe(3));' 
          };
        }

        if (eventType === 'file.write' && turn === 2) {
          payload.path = 'calculator.test.ts';
          payload.diff = '+ import { add } from "./calculator";\n+ test("add", () => expect(add(1,2)).toBe(3));';
        }

        yield {
          eventId: `evt_${Date.now()}_${sequence++}`,
          eventType,
          sessionId,
          sequence: sequence - 1,
          timestamp: new Date(),
          payload,
          rawEvent: { type: eventType, data: payload }
        };

        await new Promise(resolve => setTimeout(resolve, delay));
      }
    }).bind(this)();
  }

  private async runGenerator(sessionId: string, generator: AsyncGenerator<NormalizedEvent>): Promise<void> {
    const session = this.sessions.get(sessionId);
    if (!session) return;

    try {
      for await (const event of generator) {
        const buffer = this.eventBuffers.get(sessionId) || [];
        buffer.push(event);
        this.eventBuffers.set(sessionId, buffer);
        this.sequenceCounters.set(sessionId, event.sequence + 1);
        this.emit('event', event);
      }
      
      session.status = 'completed';
      this.emit('session:ended', { session, events: this.eventBuffers.get(sessionId) || [] });
    } catch (error) {
      session.status = 'crashed';
      this.emit('session:ended', { session, error, events: this.eventBuffers.get(sessionId) || [] });
    } finally {
      this.eventGenerators.delete(sessionId);
    }
  }

  parseEvent(line: string, sessionId: string, sequence: number): NormalizedEvent | null {
    return null;
  }

  normalizeExitCode(code: number | null, signal: NodeJS.Signals | null): { success: boolean; status: Session['status'] } {
    const session = Array.from(this.sessions.values()).find(s => s.status === 'running' || s.status === 'crashed');
    if (session?.status === 'crashed') {
      return { success: false, status: 'crashed' };
    }
    return { success: true, status: 'completed' };
  }

  async stop(sessionId: string) {
    const generator = this.eventGenerators.get(sessionId);
    if (generator) {
      await generator.return();
    }
    return super.stop(sessionId);
  }

  getScenarioEvents(scenario: string): NormalizedEvent['eventType'][] {
    return SCENARIOS[scenario] || [];
  }
}