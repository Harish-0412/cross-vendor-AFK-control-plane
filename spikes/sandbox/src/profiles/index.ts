import { Platform, SandboxProfile, FilesystemRules, ProcessRules, NetworkRules, ResourceLimits } from './types';

export const PLATFORM: Platform = process.platform as Platform;

export const PROFILES: Record<string, SandboxProfile> = {
  strict: {
    name: 'strict',
    description: 'Maximum isolation for AFK/untrusted execution',
    filesystem: {
      readPaths: ['${workspace}'],
      writePaths: ['${workspace}'],
      denyPaths: [
        '${home}/.ssh',
        '${home}/.aws',
        '${home}/.config',
        '${home}/.env*',
        '/etc',
        '/root',
        '/home/*/.ssh',
        '/home/*/.aws',
        '/home/*/.config',
        '/proc',
        '/sys',
        '/dev'
      ],
      followSymlinks: false,
      allowTmp: false
    },
    process: {
      allowList: ['git', 'npm', 'node', 'python3', 'python', 'cargo', 'go', 'bun', 'deno', 'pnpm', 'yarn'],
      denyList: ['sudo', 'su', 'doas', 'systemctl', 'service', 'docker', 'podman', 'kubectl', 'helm', 'ssh', 'scp', 'rsync'],
      allowShell: false,
      maxProcesses: 10
    },
    network: {
      mode: 'none',
      allowedPorts: [],
      allowedHosts: [],
      denyLocalhost: true
    },
    resources: {
      cpuPercent: 50,
      memoryMB: 2048,
      diskMB: 1024,
      processes: 10,
      openFiles: 256
    }
  },
  standard: {
    name: 'standard',
    description: 'Balanced isolation for interactive development',
    filesystem: {
      readPaths: ['${workspace}', '${home}/.cache', '/tmp'],
      writePaths: ['${workspace}', '/tmp'],
      denyPaths: [
        '${home}/.ssh',
        '${home}/.aws',
        '${home}/.config/gcloud',
        '${home}/.kube',
        '${home}/.env*',
        '/etc',
        '/root'
      ],
      followSymlinks: true,
      allowTmp: true
    },
    process: {
      allowList: ['git', 'npm', 'node', 'python3', 'python', 'cargo', 'go', 'bun', 'deno', 'pnpm', 'yarn', 'make', 'cmake', 'jq', 'curl', 'wget'],
      denyList: ['sudo', 'su', 'doas', 'systemctl', 'service', 'docker', 'podman', 'kubectl', 'helm'],
      allowShell: true,
      maxProcesses: 20
    },
    network: {
      mode: 'localhost',
      allowedPorts: [3000, 3001, 4000, 5000, 8000, 8080, 8888, 9000],
      allowedHosts: ['localhost', '127.0.0.1', '::1'],
      denyLocalhost: false
    },
    resources: {
      cpuPercent: 75,
      memoryMB: 4096,
      diskMB: 2048,
      processes: 20,
      openFiles: 512
    }
  },
  permissive: {
    name: 'permissive',
    description: 'Minimal isolation for trusted development',
    filesystem: {
      readPaths: ['${workspace}', '${home}', '/tmp', '/usr', '/opt'],
      writePaths: ['${workspace}', '/tmp'],
      denyPaths: [
        '${home}/.ssh',
        '${home}/.aws',
        '${home}/.config/gcloud',
        '${home}/.kube',
        '/etc/shadow',
        '/etc/sudoers*',
        '/root'
      ],
      followSymlinks: true,
      allowTmp: true
    },
    process: {
      allowList: [],
      denyList: ['sudo', 'su', 'doas', 'systemctl', 'service', 'docker', 'podman', 'kubectl', 'helm', 'mount', 'umount'],
      allowShell: true,
      maxProcesses: 50
    },
    network: {
      mode: 'outbound',
      allowedPorts: [],
      allowedHosts: [],
      denyLocalhost: false
    },
    resources: {
      cpuPercent: 100,
      memoryMB: 8192,
      diskMB: 5120,
      processes: 50,
      openFiles: 1024
    }
  }
};

export function resolvePaths(rules: FilesystemRules, workspace: string, home: string): FilesystemRules {
  const replace = (path: string): string => {
    return path
      .replace('${workspace}', workspace)
      .replace('${home}', home);
  };

  return {
    ...rules,
    readPaths: rules.readPaths.map(replace),
    writePaths: rules.writePaths.map(replace),
    denyPaths: rules.denyPaths.map(replace)
  };
}

export function getProfile(name: string): SandboxProfile {
  const profile = PROFILES[name];
  if (!profile) {
    throw new Error(`Unknown sandbox profile: ${name}`);
  }
  return profile;
}

export function listProfiles(): string[] {
  return Object.keys(PROFILES);
}