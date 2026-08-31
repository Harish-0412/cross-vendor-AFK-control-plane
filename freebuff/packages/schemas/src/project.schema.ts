import { z } from 'zod';

import { PROJECT_ID_PREFIX, PROJECT_ID_LENGTH } from '@freebuff/protocol';

export const VcsTypeSchema = z.enum(['git', 'none', 'unknown']);
export const NetworkCapabilitiesSchema = z.enum(['none', 'restricted', 'full']);

export const ProjectIdSchema = z
  .string()
  .startsWith(PROJECT_ID_PREFIX)
  .length(PROJECT_ID_PREFIX.length + PROJECT_ID_LENGTH);

export const ProjectInfoSchema = z.object({
  id: ProjectIdSchema,
  name: z.string().min(1),
  root: z.string().min(1),
  vcs: VcsTypeSchema,
  defaultBranch: z.string().optional(),
  currentBranch: z.string().optional(),
  lastCommitHash: z.string().optional(),
  lastCommitAt: z.coerce.date().optional(),
  createdAt: z.coerce.date(),
  lastAccessedAt: z.coerce.date(),
  metadata: z.record(z.string(), z.unknown()),
});

export const ProjectValidationSchema = z.object({
  valid: z.boolean(),
  projectRoot: z.string().min(1),
  resolvedRoot: z.string().min(1),
  isGitRepo: z.boolean(),
  defaultBranch: z.string().optional(),
  currentBranch: z.string().optional(),
  writablePaths: z.array(z.string()),
  readablePaths: z.array(z.string()),
  deniedPaths: z.array(z.string()),
  networkCapabilities: NetworkCapabilitiesSchema,
  hasSymlinkEscape: z.boolean(),
  hasTraversalRisk: z.boolean(),
  errors: z.array(z.string()),
  warnings: z.array(z.string()),
});

export const ProjectRegistrationOptionsSchema = z.object({
  root: z.string().min(1),
  name: z.string().min(1).optional(),
  autoDetectGit: z.boolean().optional(),
  allowedPaths: z.array(z.string()).optional(),
  deniedPaths: z.array(z.string()).optional(),
  networkCapabilities: NetworkCapabilitiesSchema.optional(),
});

export const ProjectFilterSchema = z.object({
  name: z.string().optional(),
  hasGit: z.boolean().optional(),
  accessedAfter: z.coerce.date().optional(),
  limit: z.number().int().positive().optional(),
  offset: z.number().int().nonnegative().optional(),
});

export const ProjectStatsSchema = z.object({
  totalProjects: z.number().int().nonnegative(),
  gitProjects: z.number().int().nonnegative(),
  activeSessions: z.number().int().nonnegative(),
  totalSessions: z.number().int().nonnegative(),
  recentlyAccessed: z.number().int().nonnegative(),
});

export function validateProject(data: unknown) {
  return ProjectInfoSchema.safeParse(data);
}

export function validateProjectRegistration(data: unknown) {
  return ProjectRegistrationOptionsSchema.safeParse(data);
}

export function validateProjectId(id: string) {
  return ProjectIdSchema.safeParse(id);
}
