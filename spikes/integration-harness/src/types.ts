export interface AgentConfig {
  agent: string;
  workspace: string;
  prompt: string;
  model?: string;
  approvalMode?: 'auto' | 'ask' | 'never';
  env?: Record<string, string>;
  timeout?: number;
  maxTurns?: number;
}

export interface Session {
  id: string;
  agent: string;
  pid: number;
  startTime: Date;
  status: 'starting' | 'running' | 'completed' | 'failed' | 'cancelled' | 'crashed';
  workspace: string;
  config: AgentConfig;
}

export interface AgentEvent {
  type: string;
  timestamp: Date;
  sequence: number;
  payload: any;
  raw?: string;
}

export interface NormalizedEvent {
  eventId: string;
  eventType: EventType;
  sessionId: string;
  sequence: number;
  timestamp: Date;
  payload: any;
  rawEvent: any;
}

export type EventType = 
  | 'session.started'
  | 'session.resumed'
  | 'session.checkpoint'
  | 'session.completed'
  | 'session.failed'
  | 'session.cancelled'
  | 'session.crashed'
  | 'user.message'
  | 'assistant.message'
  | 'assistant.thinking'
  | 'tool.call'
  | 'tool.result'
  | 'tool.error'
  | 'file.read'
  | 'file.write'
  | 'file.edit'
  | 'file.delete'
  | 'bash.exec'
  | 'bash.output'
  | 'approval.requested'
  | 'approval.granted'
  | 'approval.denied'
  | 'policy.violation'
  | 'network.request'
  | 'metrics.usage'
  | 'error';

export interface HarnessResult {
  session: Session;
  events: NormalizedEvent[];
  rawEvents: AgentEvent[];
  exitCode: number | null;
  duration: number;
  success: boolean;
  error?: string;
}

export interface IntegrationHarness {
  detect(agent: string): Promise<boolean>;
  listAgents(): Promise<string[]>;
  start(config: AgentConfig): Promise<Session>;
  prompt(sessionId: string, message: string): Promise<void>;
  captureOutput(sessionId: string): AsyncIterable<NormalizedEvent>;
  followUp(sessionId: string, message: string): Promise<void>;
  stop(sessionId: string): Promise<HarnessResult>;
  getSession(sessionId: string): Session | undefined;
  listSessions(): Session[];
}

export interface AgentAdapter {
  readonly name: string;
  readonly version: string;
  detect(): Promise<boolean>;
  getCommand(config: AgentConfig): { command: string; args: string[] };
  parseEvent(line: string, sessionId: string, sequence: number): NormalizedEvent | null;
  normalizeExitCode(code: number | null, signal: NodeJS.Signals | null): { success: boolean; status: Session['status'] };
}

export interface MockAgentConfig {
  scenario: 'basic' | 'multi-turn' | 'approval' | 'error' | 'crash';
  delay?: number;
  crashAtTurn?: number;
  approvalRequired?: boolean;
  customEvents?: NormalizedEvent[];
}

export interface TestScenario {
  name: string;
  description: string;
  steps: TestStep[];
  expectedOutcome: 'success' | 'failure' | 'cancelled';
  timeout?: number;
}

export interface TestStep {
  action: 'prompt' | 'followup' | 'wait' | 'kill' | 'restart';
  payload?: string;
  delay?: number;
  expectedEvents?: EventType[];
}

export interface HarnessOptions {
  logLevel?: 'debug' | 'info' | 'warn' | 'error';
  outputDir?: string;
  saveRawEvents?: boolean;
  saveNormalizedEvents?: boolean;
}