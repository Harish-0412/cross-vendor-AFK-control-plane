#!/usr/bin/env node
import { Command } from 'commander';
import { AgentHarness } from './harness';
import { MockAgentAdapter } from './agents/mock';
import { logger } from './utils/logger';
import * as fs from 'fs/promises';
import * as path from 'path';

const program = new Command();
const harness = new AgentHarness();

program
  .name('integration-harness')
  .description('Disposable integration test harness for AI coding agents')
  .version('0.1.0');

program
  .command('list-agents')
  .description('List all registered agents')
  .action(async () => {
    const agents = [
      { name: 'mock', version: '0.1.0', description: 'Deterministic mock agent for testing' },
      { name: 'opencode', version: '0.1.0', description: 'OpenCode AI coding agent' }
    ];
    
    console.log('\nRegistered Agents:');
    for (const agent of agents) {
      console.log(`  ${agent.name} v${agent.version} - ${agent.description}`);
    }
    console.log();
  });

program
  .command('detect')
  .description('Detect installed agents')
  .action(async () => {
    console.log('\nDetecting agents...\n');
    
    const mockDetected = await harness.detect('mock');
    console.log(`  mock:     ${mockDetected ? '✓ Available' : '✗ Not available'}`);
    
    const opencodeDetected = await harness.detect('opencode');
    console.log(`  opencode: ${opencodeDetected ? '✓ Available' : '✗ Not installed'}`);
    console.log();
  });

program
  .command('run')
  .description('Run a test session')
  .requiredOption('-a, --agent <agent>', 'Agent to use (mock, opencode)')
  .option('-p, --prompt <prompt>', 'Initial prompt')
  .option('-s, --scenario <scenario>', 'Test scenario (basic-session, multi-prompt, crash-recovery)')
  .option('-w, --workspace <path>', 'Workspace directory', process.cwd())
  .option('-m, --model <model>', 'Model to use')
  .option('--approval-mode <mode>', 'Approval mode (auto, ask, never)', 'auto')
  .option('--timeout <ms>', 'Timeout in milliseconds', '60000')
  .option('--log-level <level>', 'Log level (debug, info, warn, error)', 'info')
  .action(async (options) => {
    logger.setLevel(options.logLevel as any);
    
    try {
      await harness.useAgent(options.agent);
      
      const mockAdapter = harness.getAdapter('mock') as MockAgentAdapter;
      
      if (options.scenario && mockAdapter) {
        mockAdapter.configure({ 
          scenario: options.scenario as any,
          delay: 100
        });
      }
      
      const config = {
        agent: options.agent,
        workspace: options.workspace,
        prompt: options.prompt || 'Create a simple hello world function',
        model: options.model,
        approvalMode: options.approvalMode as any,
        timeout: parseInt(options.timeout)
      };
      
      console.log('\nStarting session...');
      const session = await harness.start(config);
      console.log(`Session: ${session.id}`);
      console.log(`PID: ${session.pid}`);
      console.log(`Workspace: ${session.workspace}\n`);
      
      console.log('Events:');
      for await (const event of harness.captureOutput(session.id)) {
        console.log(`  [${event.sequence}] ${event.eventType}: ${JSON.stringify(event.payload).slice(0, 100)}`);
      }
      
      console.log('\nStopping session...');
      const result = await harness.stop(session.id);
      
      console.log('\nResult:');
      console.log(`  Status: ${result.session.status}`);
      console.log(`  Exit Code: ${result.exitCode}`);
      console.log(`  Duration: ${result.duration}ms`);
      console.log(`  Events: ${result.events.length}`);
      console.log(`  Success: ${result.success}`);
      if (result.error) {
        console.log(`  Error: ${result.error}`);
      }
      
      await harness.shutdown();
      process.exit(result.success ? 0 : 1);
      
    } catch (error) {
      logger.error('Run failed', { error: error instanceof Error ? error.message : String(error) });
      await harness.shutdown();
      process.exit(1);
    }
  });

program
  .command('test-scenario')
  .description('Run a predefined test scenario')
  .requiredOption('-a, --agent <agent>', 'Agent to use')
  .requiredOption('-s, --scenario <scenario>', 'Scenario name')
  .option('--log-level <level>', 'Log level', 'info')
  .action(async (options) => {
    logger.setLevel(options.logLevel as any);
    
    const scenarios = {
      'basic-session': {
        name: 'basic-session',
        description: 'Basic single-prompt session',
        steps: [
          { action: 'prompt' as const, payload: 'Create a simple calculator function' }
        ],
        expectedOutcome: 'success' as const
      },
      'multi-prompt': {
        name: 'multi-prompt',
        description: 'Multi-turn conversation',
        steps: [
          { action: 'prompt' as const, payload: 'Create a calculator function' },
          { action: 'followup' as const, payload: 'Add unit tests' },
          { action: 'followup' as const, payload: 'Add error handling' }
        ],
        expectedOutcome: 'success' as const
      },
      'crash-recovery': {
        name: 'crash-recovery',
        description: 'Crash and recovery test',
        steps: [
          { action: 'prompt' as const, payload: 'Create a complex function' },
          { action: 'wait' as const, delay: 500 },
          { action: 'kill' as const }
        ],
        expectedOutcome: 'cancelled' as const
      }
    };
    
    const scenario = scenarios[options.scenario as keyof typeof scenarios];
    if (!scenario) {
      console.error(`Unknown scenario: ${options.scenario}`);
      console.error('Available:', Object.keys(scenarios).join(', '));
      process.exit(1);
    }
    
    try {
      await harness.useAgent(options.agent);
      
      const mockAdapter = harness.getAdapter('mock') as MockAgentAdapter;
      if (mockAdapter) {
        mockAdapter.configure({ scenario: options.scenario as any, delay: 50 });
      }
      
      const result = await harness.runScenario(scenario);
      
      console.log('\nScenario Result:');
      console.log(`  Status: ${result.session.status}`);
      console.log(`  Success: ${result.success}`);
      console.log(`  Events: ${result.events.length}`);
      
      await harness.shutdown();
      process.exit(result.success ? 0 : 1);
      
    } catch (error) {
      logger.error('Scenario failed', { error: error instanceof Error ? error.message : String(error) });
      await harness.shutdown();
      process.exit(1);
    }
  });

program
  .command('export-events')
  .description('Export events from last session')
  .option('-o, --output <file>', 'Output file path')
  .option('-f, --format <format>', 'Format (json, jsonl)', 'jsonl')
  .action(async (options) => {
    const sessions = harness.listSessions();
    if (sessions.length === 0) {
      console.error('No sessions found');
      process.exit(1);
    }
    
    const session = sessions[sessions.length - 1];
    const adapter = harness.getAdapter(session.agent);
    if (!adapter) {
      console.error('Adapter not found');
      process.exit(1);
    }
    
    const events = adapter.getEvents(session.id);
    const output = options.format === 'json' 
      ? JSON.stringify(events, null, 2)
      : events.map(e => JSON.stringify(e)).join('\n');
    
    if (options.output) {
      await fs.writeFile(options.output, output);
      console.log(`Events written to ${options.output}`);
    } else {
      console.log(output);
    }
  });

program.parse(process.argv);

if (!process.argv.slice(2).length) {
  program.help();
}