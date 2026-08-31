import { AgentConfig, NormalizedEvent, Session } from '../types';
import { BaseAgentAdapter } from './base';
import { parseJsonLine } from '../utils/events';
import { logger } from '../utils/logger';

export class OpenCodeAdapter extends BaseAgentAdapter {
  readonly name = 'opencode';
  readonly version = '0.1.0';

  async detect(): Promise<boolean> {
    try {
      const { runCommand } = await import('../utils/process');
      const result = await runCommand('opencode', ['--version'], { timeout: 5000 });
      logger.info('OpenCode detected', { version: result.stdout.trim() });
      return result.exitCode === 0;
    } catch {
      logger.warn('OpenCode not found');
      return false;
    }
  }

  getCommand(config: AgentConfig): { command: string; args: string[] } {
    const args = [
      'run',
      '--headless',
      '--json',
      '--prompt', config.prompt,
      '--workspace', config.workspace
    ];

    if (config.approvalMode) {
      args.push('--approval-mode', config.approvalMode);
    }
    if (config.model) {
      args.push('--model', config.model);
    }
    if (config.maxTurns) {
      args.push('--max-turns', config.maxTurns.toString());
    }
    if (config.timeout) {
      args.push('--timeout', Math.floor(config.timeout / 1000).toString());
    }

    return { command: 'opencode', args };
  }

  parseEvent(line: string, sessionId: string, sequence: number): NormalizedEvent | null {
    const parsed = parseJsonLine(line);
    if (!parsed) return null;

    if (!parsed.event) return null;

    const eventMap: Record<string, NormalizedEvent['eventType']> = {
      'session.start': 'session.started',
      'message': 'assistant.message',
      'tool_call': 'tool.call',
      'tool_result': 'tool.result',
      'file_change': 'file.write',
      'approval_request': 'approval.requested',
      'session.complete': 'session.completed',
      'session.error': 'session.failed',
      'turn': 'metrics.usage'
    };

    const eventType = eventMap[parsed.event];
    if (!eventType) {
      logger.debug('Unknown OpenCode event type', { event: parsed.event });
      return null;
    }

    return {
      eventId: `evt_${Date.now()}_${sequence}`,
      eventType,
      sessionId,
      sequence,
      timestamp: parsed.timestamp ? new Date(parsed.timestamp) : new Date(),
      payload: parsed.data || parsed,
      rawEvent: parsed
    };
  }

  normalizeExitCode(code: number | null, signal: NodeJS.Signals | null): { success: boolean; status: Session['status'] } {
    if (signal === 'SIGKILL' || signal === 'SIGTERM') {
      return { success: false, status: 'cancelled' };
    }
    if (signal === 'SIGINT') {
      return { success: false, status: 'cancelled' };
    }
    switch (code) {
      case 0:
        return { success: true, status: 'completed' };
      case 1:
      case 2:
      case 3:
        return { success: false, status: 'failed' };
      case 4:
        return { success: false, status: 'cancelled' };
      case 5:
        return { success: false, status: 'failed' };
      case 130:
        return { success: false, status: 'cancelled' };
      case 137:
        return { success: false, status: 'cancelled' };
      default:
        return { success: false, status: 'failed' };
    }
  }
}