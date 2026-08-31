import { IntegrationHarness, AgentConfig, Session, NormalizedEvent, HarnessResult, TestScenario } from './types';
import { BaseAgentAdapter } from './agents/base';
import { OpenCodeAdapter } from './agents/opencode';
import { MockAgentAdapter } from './agents/mock';
import { logger } from './utils/logger';

export class AgentHarness implements IntegrationHarness {
  private adapters: Map<string, BaseAgentAdapter> = new Map();
  private currentAdapter: BaseAgentAdapter | null = null;

  constructor() {
    this.registerAdapter(new MockAgentAdapter());
    this.registerAdapter(new OpenCodeAdapter());
  }

  registerAdapter(adapter: BaseAgentAdapter): void {
    this.adapters.set(adapter.name, adapter);
    logger.debug(`Registered adapter: ${adapter.name} v${adapter.version}`);
  }

  getAdapter(name: string): BaseAgentAdapter | undefined {
    return this.adapters.get(name);
  }

  async detect(agent: string): Promise<boolean> {
    const adapter = this.adapters.get(agent);
    if (!adapter) {
      logger.warn(`Unknown agent: ${agent}`);
      return false;
    }
    return adapter.detect();
  }

  async listAgents(): Promise<string[]> {
    const available: string[] = [];
    for (const [name, adapter] of this.adapters) {
      if (await adapter.detect()) {
        available.push(name);
      }
    }
    return available;
  }

  useAgent(agent: string): void {
    const adapter = this.adapters.get(agent);
    if (!adapter) {
      throw new Error(`Unknown agent: ${agent}`);
    }
    this.currentAdapter = adapter;
    logger.info(`Using agent: ${agent}`);
  }

  async start(config: AgentConfig): Promise<Session> {
    if (!this.currentAdapter) {
      throw new Error('No agent selected. Call useAgent() first.');
    }
    return this.currentAdapter.start(config);
  }

  async prompt(sessionId: string, message: string): Promise<void> {
    if (!this.currentAdapter) {
      throw new Error('No agent selected');
    }
    return this.currentAdapter.prompt(sessionId, message);
  }

  async captureOutput(sessionId: string): AsyncIterable<NormalizedEvent> {
    if (!this.currentAdapter) {
      throw new Error('No agent selected');
    }
    return this.currentAdapter.captureOutput(sessionId);
  }

  async followUp(sessionId: string, message: string): Promise<void> {
    return this.prompt(sessionId, message);
  }

  async stop(sessionId: string): Promise<HarnessResult> {
    if (!this.currentAdapter) {
      throw new Error('No agent selected');
    }
    return this.currentAdapter.stop(sessionId);
  }

  getSession(sessionId: string): Session | undefined {
    if (!this.currentAdapter) return undefined;
    return this.currentAdapter.getSession(sessionId);
  }

  listSessions(): Session[] {
    if (!this.currentAdapter) return [];
    return this.currentAdapter.listSessions();
  }

  async runScenario(scenario: TestScenario): Promise<HarnessResult> {
    if (!this.currentAdapter) {
      throw new Error('No agent selected');
    }

    logger.info(`Running scenario: ${scenario.name}`);
    
    const config: AgentConfig = {
      agent: this.currentAdapter.name,
      workspace: process.cwd(),
      prompt: scenario.steps[0]?.payload || 'Test prompt',
      timeout: scenario.timeout || 60000
    };

    const session = await this.start(config);
    let lastEventIndex = 0;

    for (const step of scenario.steps) {
      switch (step.action) {
        case 'prompt':
          await this.prompt(session.id, step.payload || '');
          break;
        case 'followup':
          await this.followUp(session.id, step.payload || '');
          break;
        case 'wait':
          await new Promise(resolve => setTimeout(resolve, step.delay || 1000));
          break;
        case 'kill':
          await this.currentAdapter.kill(session.id, 'SIGKILL');
          break;
        case 'restart':
          throw new Error('Restart not implemented in scenario runner');
      }

      if (step.expectedEvents) {
        const events = this.currentAdapter.getEvents(session.id);
        const newEvents = events.slice(lastEventIndex);
        lastEventIndex = events.length;
        
        for (const expected of step.expectedEvents) {
          const found = newEvents.some(e => e.eventType === expected);
          if (!found) {
            logger.warn(`Expected event ${expected} not found in step`);
          }
        }
      }
    }

    return this.stop(session.id);
  }

  async shutdown(): Promise<void> {
    for (const adapter of this.adapters.values()) {
      await adapter.shutdown();
    }
  }
}

export function createHarness(): IntegrationHarness {
  return new AgentHarness();
}