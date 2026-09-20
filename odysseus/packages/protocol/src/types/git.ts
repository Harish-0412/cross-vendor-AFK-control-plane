import type { TrustProfile } from './policy';

export interface GitTestResult {
  command: string[];
  passed: boolean;
  exitCode: number | null;
  stdout: string;
  stderr: string;
}

export interface GitReviewBundle {
  sessionId: string;
  projectId?: string;
  generatedAt: Date;
  diff: string;
  summary: unknown;
  tests: GitTestResult | null;
  status: 'ready' | 'tests_failed' | 'blocked_by_policy' | 'collection_failed';
  policyDenial?: string;
  error?: string;
}

export interface ProjectPreferences {
  preferredAdapter?: string;
  defaultTrustProfile?: TrustProfile;
  defaultBranch?: string;
  protectedBranches: string[];
  githubRepository?: string;
}
