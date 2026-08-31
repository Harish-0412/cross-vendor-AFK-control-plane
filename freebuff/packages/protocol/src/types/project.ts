export type NetworkCapabilities = 'none' | 'restricted' | 'full';

export type VcsType = 'git' | 'none' | 'unknown';

export interface ProjectInfo {
  id: string;
  name: string;
  root: string;
  vcs: VcsType;
  defaultBranch?: string;
  currentBranch?: string;
  lastCommitHash?: string;
  lastCommitAt?: Date;
  createdAt: Date;
  lastAccessedAt: Date;
  metadata: Record<string, unknown>;
}

export interface ProjectValidation {
  valid: boolean;
  projectRoot: string;
  resolvedRoot: string;
  isGitRepo: boolean;
  defaultBranch?: string;
  currentBranch?: string;
  writablePaths: string[];
  readablePaths: string[];
  deniedPaths: string[];
  networkCapabilities: NetworkCapabilities;
  hasSymlinkEscape: boolean;
  hasTraversalRisk: boolean;
  errors: string[];
  warnings: string[];
}

export interface ProjectRegistrationOptions {
  root: string;
  name?: string;
  autoDetectGit?: boolean;
  allowedPaths?: string[];
  deniedPaths?: string[];
  networkCapabilities?: NetworkCapabilities;
}

export interface ProjectFilter {
  name?: string;
  hasGit?: boolean;
  accessedAfter?: Date;
  limit?: number;
  offset?: number;
}

export interface ProjectStats {
  totalProjects: number;
  gitProjects: number;
  activeSessions: number;
  totalSessions: number;
  recentlyAccessed: number;
}

export const PROJECT_ID_PREFIX = 'proj_';
export const PROJECT_ID_LENGTH = 24;

export const DEFAULT_DENIED_PATHS: string[] = [
  '~/.ssh',
  '~/.aws',
  '~/.config/gcloud',
  '~/.kube',
  '~/.env*',
  '/etc/shadow',
  '/etc/sudoers*',
  '/root',
  '**/.env*',
  '**/*.pem',
  '**/*.key',
];

export const DEFAULT_WRITABLE_CHILDREN: string[] = [
  'src',
  'lib',
  'test',
  'tests',
  '__tests__',
  'docs',
  'public',
  'assets',
  'tmp',
  'temp',
  'dist',
  'build',
  '.git',
];

export function isValidProjectId(id: string): boolean {
  return id.startsWith(PROJECT_ID_PREFIX) && id.length === PROJECT_ID_PREFIX.length + PROJECT_ID_LENGTH;
}

export function deriveProjectName(root: string): string {
  const normalized = root.replace(/[/\\]+$/, '');
  const parts = normalized.split(/[/\\]/);
  return parts[parts.length - 1] ?? normalized;
}

export function resolveNetworkCapabilities(
  explicit?: NetworkCapabilities,
  hasGitRemote?: boolean,
): NetworkCapabilities {
  if (explicit) return explicit;
  return hasGitRemote ? 'restricted' : 'none';
}
