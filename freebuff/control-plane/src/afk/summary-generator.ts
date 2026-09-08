import type { AuditEvent, StoredEvent } from '../types';
import type { IDatabase } from '../db/types';

export interface SessionSummary {
  sessionId: string;
  generatedAt: Date;
  fixedTests: number;
  modifiedFiles: number;
  addedTests: number;
  approvalsRequired: string[];
  workingTreeClean: boolean;
  lines: string[];
  text: string;
}

export class SummaryGenerator {
  constructor(private readonly db: IDatabase) {}

  async generate(sessionId: string, from?: Date): Promise<SessionSummary> {
    const events = (await this.db.events.listBySession(sessionId)).filter(
      (event) => !from || event.storedAt >= from,
    );
    const audit = (await this.db.audit.list({ sessionId, limit: 500 })).filter(
      (event) => !from || event.timestamp >= from,
    );
    const fixedTests = events.filter(isSuccessfulTestResult).length;
    const modifiedFiles = events.filter((event) => fileChangeKind(event) === 'modified').length;
    const addedTests = events.filter((event) => {
      const kind = fileChangeKind(event);
      return (kind === 'added' || kind === 'created') && isTestFile(event);
    }).length;
    const approvalsRequired = approvalDescriptions(events, audit);
    const workingTreeClean = events.some(isCleanWorkingTreeResult);
    const lines = [
      'While you were away',
      `✓ Fixed ${fixedTests} tests`,
      `✓ Modified ${modifiedFiles} files`,
      `✓ Added ${addedTests} tests`,
      ...approvalsRequired.map((description) => `⚠ ${description}`),
      ...(workingTreeClean ? ['✓ Working tree clean'] : []),
    ];
    return {
      sessionId,
      generatedAt: new Date(),
      fixedTests,
      modifiedFiles,
      addedTests,
      approvalsRequired,
      workingTreeClean,
      lines,
      text: lines.join('\n'),
    };
  }
}

function payload(event: StoredEvent): Record<string, unknown> {
  const value = event.envelope.payload;
  return typeof value === 'object' && value !== null ? value as Record<string, unknown> : {};
}

function isSuccessfulTestResult(event: StoredEvent): boolean {
  if (event.eventType !== 'session.tool_result') return false;
  const data = payload(event);
  const tool = String(data['toolName'] ?? data['tool'] ?? data['command'] ?? '').toLowerCase();
  return Boolean(data['success'] ?? data['passed']) && /test|vitest|jest|pytest/.test(tool);
}

function fileChangeKind(event: StoredEvent): string | undefined {
  if (event.eventType !== 'session.file_changed') return undefined;
  const data = payload(event);
  return String(data['kind'] ?? data['changeType'] ?? data['action'] ?? '').toLowerCase();
}

function isTestFile(event: StoredEvent): boolean {
  const data = payload(event);
  const path = String(data['path'] ?? data['file'] ?? data['filename'] ?? '').toLowerCase();
  return /(test|spec)\.[cm]?[jt]sx?$/.test(path);
}

function isCleanWorkingTreeResult(event: StoredEvent): boolean {
  if (event.eventType !== 'session.tool_result') return false;
  const data = payload(event);
  const tool = String(data['toolName'] ?? data['tool'] ?? data['command'] ?? '').toLowerCase();
  const output = String(data['output'] ?? data['summary'] ?? '').toLowerCase();
  return tool.includes('git') && /working tree clean|nothing to commit/.test(output);
}

function approvalDescriptions(events: StoredEvent[], audit: AuditEvent[]): string[] {
  const descriptions = new Set<string>();
  for (const event of events) {
    if (event.eventType !== 'session.approval_required') continue;
    const data = payload(event);
    const action = String(data['actionType'] ?? data['capability'] ?? data['description'] ?? '').toLowerCase();
    descriptions.add(/package|dependenc|install/.test(action) ? 'Dependency install required approval' : 'Approval required');
  }
  for (const event of audit) {
    if (event.decision !== 'require_approval') continue;
    descriptions.add(/package|dependenc|install/.test(event.action.toLowerCase()) ? 'Dependency install required approval' : 'Approval required');
  }
  return [...descriptions];
}
