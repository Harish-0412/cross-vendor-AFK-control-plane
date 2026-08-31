import type {
  SandboxProfile,
  NetworkPolicy,
  ResourceLimits,
  Platform,
} from '@freebuff/protocol';
import {
  SANDBOX_PROFILE_DEFAULTS,
  DEFAULT_DENIED_PATHS,
} from '@freebuff/protocol';

export { SANDBOX_PROFILE_DEFAULTS } from '@freebuff/protocol';

export interface ResolvedFilesystemRules {
  readPaths: string[];
  writePaths: string[];
  denyPaths: string[];
  followSymlinks: boolean;
  allowTmp: boolean;
}

export interface ResolvedProcessRules {
  allowList: string[];
  denyList: string[];
  allowShell: boolean;
  maxProcesses: number;
}

export interface ResolvedNetworkRules {
  mode: NetworkPolicy['mode'];
  allowedPorts: number[];
  allowedHosts: string[];
  denyLocalhost: boolean;
}

export interface ResolvedSandboxProfile {
  name: SandboxProfile;
  description: string;
  filesystem: ResolvedFilesystemRules;
  process: ResolvedProcessRules;
  network: ResolvedNetworkRules;
  resources: ResourceLimits;
}

const PLATFORM: Platform = process.platform as Platform;

const BASE_DENY_PATHS = [
  '${home}/.ssh',
  '${home}/.aws',
  '${home}/.config/gcloud',
  '${home}/.kube',
  '${home}/.env',
  '${home}/.env.local',
  '${home}/.npmrc',
  '${home}/.netrc',
  '${home}/.pgpass',
  '/etc/shadow',
  '/etc/sudoers',
  '/etc/sudoers.d',
  '/root',
  '/proc',
  '/sys',
  '/dev',
  '**/*.pem',
  '**/*.key',
  '**/*.p12',
  '**/*.pfx',
];

const PROFILES: Record<SandboxProfile, Omit<ResolvedSandboxProfile, 'filesystem' | 'process' | 'network' | 'resources'> & {
  filesystem: Omit<ResolvedFilesystemRules, never>;
  process: Omit<ResolvedProcessRules, never>;
  network: Omit<ResolvedNetworkRules, never>;
  resources: ResourceLimits;
}> = {
  strict: {
    name: 'strict',
    description: 'Maximum isolation for AFK/untrusted execution',
    filesystem: {
      readPaths: ['${workspace}'],
      writePaths: ['${workspace}'],
      denyPaths: [...BASE_DENY_PATHS],
      followSymlinks: false,
      allowTmp: false,
    },
    process: {
      allowList: ['git', 'npm', 'node', 'python3', 'python', 'cargo', 'go', 'bun', 'deno', 'pnpm', 'yarn'],
      denyList: ['sudo', 'su', 'doas', 'systemctl', 'service', 'docker', 'podman', 'kubectl', 'helm', 'ssh', 'scp', 'rsync', 'nc', 'ncat', 'netcat', 'curl', 'wget'],
      allowShell: false,
      maxProcesses: 10,
    },
    network: {
      mode: 'deny-all',
      allowedPorts: [],
      allowedHosts: [],
      denyLocalhost: true,
    },
    resources: { ...SANDBOX_PROFILE_DEFAULTS.strict.resourceLimits },
  },
  standard: {
    name: 'standard',
    description: 'Balanced isolation for interactive development',
    filesystem: {
      readPaths: ['${workspace}', '${home}/.cache', '/tmp'],
      writePaths: ['${workspace}', '/tmp'],
      denyPaths: [...BASE_DENY_PATHS],
      followSymlinks: true,
      allowTmp: true,
    },
    process: {
      allowList: ['git', 'npm', 'node', 'python3', 'python', 'cargo', 'go', 'bun', 'deno', 'pnpm', 'yarn', 'make', 'cmake', 'jq', 'curl', 'wget'],
      denyList: ['sudo', 'su', 'doas', 'systemctl', 'service', 'docker', 'podman', 'kubectl', 'helm'],
      allowShell: true,
      maxProcesses: 20,
    },
    network: {
      mode: 'allow-list',
      allowedPorts: [80, 443, 3000, 3001, 4000, 5000, 8000, 8080, 8888, 9000, 5432, 6379],
      allowedHosts: ['localhost', '127.0.0.1', '::1', 'registry.npmjs.org', 'github.com'],
      denyLocalhost: false,
    },
    resources: { ...SANDBOX_PROFILE_DEFAULTS.standard.resourceLimits },
  },
  permissive: {
    name: 'permissive',
    description: 'Minimal isolation for trusted development',
    filesystem: {
      readPaths: ['${workspace}', '${home}', '/tmp', '/usr', '/opt', '/var/tmp'],
      writePaths: ['${workspace}', '/tmp', '/var/tmp'],
      denyPaths: [...BASE_DENY_PATHS.slice(0, 8)],
      followSymlinks: true,
      allowTmp: true,
    },
    process: {
      allowList: [],
      denyList: ['sudo', 'su', 'doas', 'systemctl', 'service', 'docker', 'podman', 'kubectl', 'helm', 'mount', 'umount'],
      allowShell: true,
      maxProcesses: 50,
    },
    network: {
      mode: 'allow-all',
      allowedPorts: [],
      allowedHosts: [],
      denyLocalhost: false,
    },
    resources: { ...SANDBOX_PROFILE_DEFAULTS.permissive.resourceLimits },
  },
};

export function getPlatform(): Platform {
  return PLATFORM;
}

export function getProfile(name: SandboxProfile): ResolvedSandboxProfile {
  const profile = PROFILES[name];
  if (!profile) {
    throw new Error(`Unknown sandbox profile: ${name}`);
  }
  return JSON.parse(JSON.stringify(profile)) as ResolvedSandboxProfile;
}

export function listProfiles(): Array<{ name: SandboxProfile; description: string }> {
  return (Object.keys(PROFILES) as SandboxProfile[]).map((name) => ({
    name,
    description: PROFILES[name].description,
  }));
}

export function resolveProfilePaths(
  profile: ResolvedSandboxProfile,
  workspace: string,
  home: string,
): ResolvedSandboxProfile {
  const replacer = (p: string) =>
    p
      .replace(/\$\{workspace\}/g, workspace)
      .replace(/\$\{home\}/g, home)
      .replace(/^~/, home);

  return {
    ...profile,
    filesystem: {
      ...profile.filesystem,
      readPaths: profile.filesystem.readPaths.map(replacer),
      writePaths: profile.filesystem.writePaths.map(replacer),
      denyPaths: [...profile.filesystem.denyPaths.map(replacer), ...DEFAULT_DENIED_PATHS.map(replacer)],
    },
  };
}

export function mergeNetworkPolicy(
  base: NetworkPolicy = { mode: 'deny-all' },
  profile: ResolvedSandboxProfile,
): NetworkPolicy {
  if (base.mode !== profile.network.mode && base.mode !== undefined) {
    return base;
  }
  return {
    mode: base.mode ?? profile.network.mode,
    allowedDomains: base.allowedDomains ?? profile.network.allowedHosts,
    allowedPorts: base.allowedPorts ?? profile.network.allowedPorts,
    allowedHosts: base.allowedHosts ?? profile.network.allowedHosts,
    denyLocalhost: base.denyLocalhost ?? profile.network.denyLocalhost,
  };
}

export function getHomeDir(): string {
  return (
    process.env.HOME ??
    process.env.USERPROFILE ??
    (process.env.HOMEDRIVE && process.env.HOMEPATH
      ? (process.env.HOMEDRIVE + process.env.HOMEPATH)
      : '/')
  );
}
