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
  /**
   * The source-control connection selected for this workspace.  The provider
   * is kept with the repository name so a project can never accidentally send
   * a GitLab or Bitbucket pull request through a GitHub credential.
   */
  repository?: RepositoryBinding;
  /** @deprecated Use `repository` so the provider travels with the name. */
  githubRepository?: string;
}

export type RepositoryProvider = 'github' | 'gitlab' | 'bitbucket';

export interface RepositoryBinding {
  provider: RepositoryProvider;
  /** Provider-native path, for example `owner/repository` or `group/project`. */
  fullName: string;
  defaultBranch?: string;
  webUrl?: string;
}
