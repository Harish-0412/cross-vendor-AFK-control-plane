import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

import type {
  ProjectInfo,
  ProjectValidation,
  ProjectRegistrationOptions,
  ProjectFilter,
  ProjectStats,
  NetworkCapabilities,
} from '@freebuff/protocol';

import {
  generateProjectId,
  deriveProjectName,
  DEFAULT_DENIED_PATHS,
} from '@freebuff/protocol';
import {
  PROJECT_ACCESS_TTL_MS,
} from '@freebuff/config';

const execFileAsync = promisify(execFile);

interface ProjectRecord {
  info: ProjectInfo;
  allowedPaths: string[];
  deniedPaths: string[];
  networkCapabilities: NetworkCapabilities;
}

export class ProjectManager {
  private projects: Map<string, ProjectRecord> = new Map();

  constructor(initialRoots: string[] = []) {
    for (const root of initialRoots) {
      void this.validateProject(root)
        .then((v) => {
          if (v.valid) {
            void this.registerProject({ root, autoDetectGit: true });
          }
        })
        .catch(() => { /* ignore validation errors for initial roots */ });
    }
  }

  async validateProject(projectRoot: string): Promise<ProjectValidation> {
    const errors: string[] = [];
    const warnings: string[] = [];
    const writablePaths: string[] = [];
    const readablePaths: string[] = [];
    const deniedPaths = [...DEFAULT_DENIED_PATHS];
    let hasSymlinkEscape = false;
    let hasTraversalRisk = false;

    let resolvedRoot: string;
    try {
      resolvedRoot = path.resolve(projectRoot);
    } catch {
      return this.makeValidation(projectRoot, projectRoot, false, errors, warnings, {
        error: 'Invalid project path',
      });
    }

    let rootStat;
    try {
      rootStat = await fs.lstat(resolvedRoot);
    } catch {
      return this.makeValidation(projectRoot, resolvedRoot, false, [...errors, `Project root does not exist: ${resolvedRoot}`], warnings);
    }
    if (!rootStat.isDirectory()) {
      return this.makeValidation(projectRoot, resolvedRoot, false, [...errors, `Project root is not a directory: ${resolvedRoot}`], warnings);
    }

    if (rootStat.isSymbolicLink()) {
      hasSymlinkEscape = true;
      warnings.push('Project root is a symbolic link');
    }

    const traversalPatterns = ['..', '../', '..\\', '%2e%2e', '..%2f'];
    for (const pattern of traversalPatterns) {
      if (projectRoot.includes(pattern)) {
        hasTraversalRisk = true;
        warnings.push(`Project path contains potential traversal pattern: ${pattern}`);
        break;
      }
    }

    let isGitRepo = false;
    let defaultBranch: string | undefined;
    let currentBranch: string | undefined;
    let lastCommitHash: string | undefined;
    let lastCommitAt: Date | undefined;

    try {
      const gitDir = path.join(resolvedRoot, '.git');
      const gitStat = await fs.lstat(gitDir);
      if (gitStat.isDirectory()) {
        isGitRepo = true;
        writablePaths.push('.git');
      }

      const branches = await this.safeGitExec(resolvedRoot, ['symbolic-ref', '--short', 'HEAD']);
      if (branches.success) {
        currentBranch = branches.stdout.trim();
      }

      const defBranch = await this.safeGitExec(resolvedRoot, [
        'config',
        '--get',
        'init.defaultBranch',
      ]);
      if (defBranch.success && defBranch.stdout.trim()) {
        defaultBranch = defBranch.stdout.trim();
      } else {
        const branchesResult = await this.safeGitExec(resolvedRoot, ['branch', '--list']);
        if (branchesResult.success) {
          const lines = branchesResult.stdout
            .split('\n')
            .map((l) => l.replace(/[*\s]/g, '').trim())
            .filter(Boolean);
          for (const candidate of ['main', 'master']) {
            if (lines.includes(candidate)) {
              defaultBranch = candidate;
              break;
            }
          }
        }
      }

      const commit = await this.safeGitExec(resolvedRoot, [
        'log',
        '-1',
        '--format=%H%x09%ct',
      ]);
      if (commit.success) {
        const [hash, unixTime] = commit.stdout.trim().split('\t');
        if (hash) lastCommitHash = hash;
        if (unixTime) lastCommitAt = new Date(parseInt(unixTime, 10) * 1000);
      }
    } catch {
      // Not a git repo, ignore errors
    }

    const homeDir = this.getHomeDir();
    const standardWriteChildren = ['src', 'lib', 'test', 'tests', '__tests__', 'docs', 'public', 'assets', 'tmp', 'temp', 'dist', 'build'];
    for (const child of standardWriteChildren) {
      const childPath = path.join(resolvedRoot, child);
      try {
        const stat = await fs.stat(childPath);
        if (stat.isDirectory()) {
          writablePaths.push(child);
        }
      } catch {
        // directory doesn't exist - skip
      }
    }

    for (const denyPattern of DEFAULT_DENIED_PATHS) {
      const expanded = denyPattern
        .replace(/^~/, homeDir)
        .replace(/\$\{home\}/gi, homeDir);
      try {
        const resolvedDeny = path.resolve(resolvedRoot, expanded);
        if (resolvedDeny.startsWith(resolvedRoot)) {
          deniedPaths.push(path.relative(resolvedRoot, resolvedDeny));
        }
      } catch {
        // ignore
      }
    }

    readablePaths.push('.');
    for (const writable of writablePaths) {
      if (!readablePaths.includes(writable)) {
        readablePaths.push(writable);
      }
    }

    const netCaps: NetworkCapabilities = isGitRepo ? 'restricted' : 'none';

    return {
      valid: errors.length === 0,
      projectRoot,
      resolvedRoot,
      isGitRepo,
      defaultBranch,
      currentBranch,
      writablePaths,
      readablePaths,
      deniedPaths,
      networkCapabilities: netCaps,
      hasSymlinkEscape,
      hasTraversalRisk,
      errors,
      warnings,
    };
  }

  async registerProject(options: ProjectRegistrationOptions): Promise<ProjectInfo> {
    const validation = await this.validateProject(options.root);
    if (!validation.valid) {
      throw new Error(
        `Project validation failed: ${validation.errors.join(', ')}`,
      );
    }

    const existing = this.findByRoot(validation.resolvedRoot);
    if (existing) {
      const updated = {
        ...existing,
        lastAccessedAt: new Date(),
      };
      const record = this.projects.get(existing.id)!;
      record.info = updated;
      return updated;
    }

    const id = generateProjectId();
    const now = new Date();
    const info: ProjectInfo = {
      id,
      name: options.name ?? deriveProjectName(validation.resolvedRoot),
      root: validation.resolvedRoot,
      vcs: validation.isGitRepo ? 'git' : 'none',
      defaultBranch: validation.defaultBranch,
      currentBranch: validation.currentBranch,
      lastCommitHash: undefined,
      lastCommitAt: undefined,
      createdAt: now,
      lastAccessedAt: now,
      metadata: {},
    };

    this.projects.set(id, {
      info,
      allowedPaths: options.allowedPaths ?? validation.writablePaths,
      deniedPaths: options.deniedPaths ?? validation.deniedPaths,
      networkCapabilities: options.networkCapabilities ?? validation.networkCapabilities,
    });

    return info;
  }

  async removeProject(projectId: string): Promise<void> {
    const record = this.projects.get(projectId);
    if (!record) {
      throw new Error(`Project not found: ${projectId}`);
    }
    this.projects.delete(projectId);
  }

  async getProject(projectId: string): Promise<ProjectInfo> {
    const record = this.projects.get(projectId);
    if (!record) throw new Error(`Project not found: ${projectId}`);
    record.info.lastAccessedAt = new Date();
    return { ...record.info };
  }

  listProjects(): ProjectInfo[] {
    const now = Date.now();
    return Array.from(this.projects.values())
      .map((r) => {
        if (now - r.info.lastAccessedAt.getTime() > PROJECT_ACCESS_TTL_MS) {
          r.info.lastAccessedAt = new Date();
        }
        return { ...r.info };
      });
  }

  filterProjects(filter: ProjectFilter): ProjectInfo[] {
    let results = this.listProjects();
    if (filter.name) {
      const q = filter.name.toLowerCase();
      results = results.filter((p) => p.name.toLowerCase().includes(q));
    }
    if (filter.hasGit !== undefined) {
      results = results.filter((p) => (p.vcs === 'git') === filter.hasGit);
    }
    if (filter.accessedAfter) {
      results = results.filter((p) => p.lastAccessedAt >= filter.accessedAfter!);
    }
    results.sort((a, b) => b.lastAccessedAt.getTime() - a.lastAccessedAt.getTime());
    const offset = filter.offset ?? 0;
    const limit = filter.limit ?? results.length;
    return results.slice(offset, offset + limit);
  }

  findByRoot(root: string): ProjectInfo | undefined {
    try {
      const resolved = path.resolve(root);
      for (const record of this.projects.values()) {
        if (record.info.root === resolved) return { ...record.info };
      }
    } catch {
      // ignore
    }
    return undefined;
  }

  getProjectStats(activeSessionCount = 0, totalSessionCount = 0): ProjectStats {
    const projects = this.listProjects();
    const recentlyAccessed = projects.filter(
      (p) => Date.now() - p.lastAccessedAt.getTime() < PROJECT_ACCESS_TTL_MS,
    ).length;
    return {
      totalProjects: projects.length,
      gitProjects: projects.filter((p) => p.vcs === 'git').length,
      activeSessions: activeSessionCount,
      totalSessions: totalSessionCount,
      recentlyAccessed,
    };
  }

  getAllowedPaths(projectId: string): string[] {
    return this.projects.get(projectId)?.allowedPaths ?? [];
  }

  getDeniedPaths(projectId: string): string[] {
    return this.projects.get(projectId)?.deniedPaths ?? [];
  }

  getNetworkCapabilities(projectId: string): NetworkCapabilities | undefined {
    return this.projects.get(projectId)?.networkCapabilities;
  }

  clear(): void {
    this.projects.clear();
  }

  private makeValidation(
    projectRoot: string,
    resolvedRoot: string,
    valid: boolean,
    errors: string[],
    warnings: string[],
    _opts?: { error?: string },
  ): ProjectValidation {
    return {
      valid,
      projectRoot,
      resolvedRoot,
      isGitRepo: false,
      writablePaths: [],
      readablePaths: [],
      deniedPaths: [...DEFAULT_DENIED_PATHS],
      networkCapabilities: 'none',
      hasSymlinkEscape: false,
      hasTraversalRisk: false,
      errors,
      warnings,
    };
  }

  private getHomeDir(): string {
    return (
      process.env.HOME ??
      process.env.USERPROFILE ??
      (process.env.HOMEDRIVE && process.env.HOMEPATH
        ? path.join(process.env.HOMEDRIVE, process.env.HOMEPATH)
        : '/')
    );
  }

  private async safeGitExec(
    cwd: string,
    args: string[],
  ): Promise<{ success: boolean; stdout: string; stderr: string }> {
    try {
      const result = await execFileAsync('git', args, {
        cwd,
        timeout: 5000,
        windowsHide: true,
      });
      return { success: true, stdout: result.stdout, stderr: result.stderr };
    } catch {
      return { success: false, stdout: '', stderr: '' };
    }
  }
}

export function createProjectManager(initialRoots?: string[]): ProjectManager {
  return new ProjectManager(initialRoots);
}
