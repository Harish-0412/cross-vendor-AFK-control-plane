/**
 * Records for the three cross-vendor features. Dates are ISO strings: these
 * are stored as JSON documents and sent to the web app unchanged.
 */

// ------------------------------------------------------------- workspaces

export interface FileChange {
  path: string;
  added: number;
  removed: number;
}

export interface TestRun {
  ran: boolean;
  passed: boolean;
  command: string;
  exitCode: number | null;
  durationMs: number;
  summary: string;
  outputTail: string;
}

export interface WorkspaceEvaluation {
  diff: string;
  diffTruncated: boolean;
  files: FileChange[];
  added: number;
  removed: number;
  tests: TestRun;
}

export interface RecentChange {
  commit: string;
  parent: string;
  title: string;
  body: string;
  date: string;
  files: FileChange[];
  testFiles: string[];
}

/** A review from an agent of a different vendor than the one that wrote the code. */
export interface CrossReview {
  reviewerAgentId: string;
  sessionId?: string | undefined;
  state: 'pending' | 'running' | 'done' | 'failed' | 'skipped';
  /** 0–10, from the reviewer. */
  score?: number;
  verdict?: 'approve' | 'changes_requested';
  summary?: string;
  issues?: string[];
  error?: string;
}

// ---------------------------------------------------------------- contest

export type EntryState =
  'preparing' | 'running' | 'evaluating' | 'reviewing' | 'done' | 'failed' | 'cancelled';

export interface ContestEntry {
  agentId: string;
  state: EntryState;
  workspaceRoot?: string;
  baseCommit?: string;
  sessionId?: string | undefined;
  startedAt?: string;
  finishedAt?: string;
  evaluation?: Omit<WorkspaceEvaluation, 'diff'> & { diff?: string | undefined };
  review?: CrossReview;
  /** 0–100: tests (60) + cross-vendor review (40). */
  score?: number;
  scoreBreakdown?: { tests: number; review: number; notes: string[] };
  error?: string;
}

export type ContestState = 'running' | 'judging' | 'decided' | 'failed' | 'cancelled';

export interface Contest {
  id: string;
  userId: string;
  projectId: string;
  projectName: string;
  projectRoot: string;
  deviceId: string;
  task: string;
  state: ContestState;
  entries: ContestEntry[];
  winnerAgentId?: string;
  decisionReason?: string;
  applied?: { agentId: string; branch: string; commit: string; at: string };
  cleanedUp?: boolean;
  error?: string;
  createdAt: string;
  updatedAt: string;
}

// ------------------------------------------------------------- benchmark

export interface BenchmarkAttempt {
  id: string;
  changeCommit: string;
  agentId: string;
  state: EntryState | 'queued';
  workspaceRoot?: string;
  sessionId?: string | undefined;
  startedAt?: string;
  finishedAt?: string;
  durationMs?: number;
  /** The real change's own tests pass on the agent's code. */
  solved?: boolean;
  testsRan?: boolean;
  testSummary?: string;
  /** Share of the real change's files the agent also changed (0–1). */
  fileOverlap?: number;
  linesChanged?: number;
  error?: string;
}

export interface BenchmarkTask {
  commit: string;
  parent: string;
  title: string;
  body: string;
  date: string;
  files: string[];
  testFiles: string[];
  linesChanged: number;
}

export type BenchmarkState = 'running' | 'completed' | 'failed' | 'cancelled';

export interface Benchmark {
  id: string;
  userId: string;
  projectId: string;
  projectName: string;
  projectRoot: string;
  deviceId: string;
  agents: string[];
  tasks: BenchmarkTask[];
  attempts: BenchmarkAttempt[];
  concurrency: number;
  state: BenchmarkState;
  error?: string;
  createdAt: string;
  updatedAt: string;
}

export interface LeaderboardRow {
  agentId: string;
  rank: number;
  attempted: number;
  solved: number;
  solveRate: number;
  averageOverlap: number;
  averageMinutes: number;
  failed: number;
}

// ------------------------------------------------------------- never idle

export interface NeverIdleSettings {
  enabled: boolean;
  /** Agents to hand off to, most preferred first. Empty: any other installed agent. */
  fallbackOrder: string[];
  /** When no other agent is available, continue with the same one after its reset. */
  resumeAfterReset: boolean;
  /** Hand-offs allowed in one chain, so two limited agents cannot ping-pong. */
  maxHandoffs: number;
}

export const DEFAULT_NEVER_IDLE: NeverIdleSettings = {
  enabled: true,
  fallbackOrder: [],
  resumeAfterReset: true,
  maxHandoffs: 3,
};

export interface VendorLimit {
  agentId: string;
  deviceId: string;
  detectedAt: string;
  /** When the provider said the limit resets; estimated when it did not say. */
  resetsAt: string;
  resetKnown: boolean;
  message: string;
  sessionId: string;
}

export interface Handoff {
  id: string;
  userId: string;
  chainId: string;
  depth: number;
  fromSessionId: string;
  fromAgentId: string;
  toSessionId?: string;
  toAgentId?: string;
  kind: 'handoff' | 'scheduled_resume' | 'no_alternative';
  reason: string;
  resetsAt?: string;
  projectRoot: string;
  createdAt: string;
  error?: string;
}

export interface ScheduledResume {
  id: string;
  userId: string;
  deviceId: string;
  agentId: string;
  fromSessionId: string;
  chainId: string;
  depth: number;
  projectId?: string;
  projectRoot: string;
  prompt: string;
  runAt: string;
  state: 'waiting' | 'started' | 'failed' | 'cancelled';
  startedSessionId?: string;
  error?: string;
}
