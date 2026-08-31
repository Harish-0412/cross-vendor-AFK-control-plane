# Sandbox Proof of Concept

Cross-platform sandbox implementation for isolating AI coding agents.

## Architecture

```
spikes/sandbox/
├── src/
│   ├── index.ts              # Main sandbox manager
│   ├── types.ts              # Shared types
│   ├── linux-sandbox.ts      # Linux namespaces + cgroups
│   ├── macos-sandbox.ts      # macOS seatbelt profiles
│   ├── windows-sandbox.ts    # Windows Job Objects + AppContainer
│   ├── platform.ts           # Platform detection & factory
│   └── profiles/
│       ├── strict.ts         # Strict isolation profile
│       ├── standard.ts       # Standard isolation profile
│       └── permissive.ts     # Permissive profile
├── test-cases/
│   ├── filesystem-isolation.test.ts
│   ├── process-isolation.test.ts
│   ├── network-isolation.test.ts
│   └── resource-limits.test.ts
└── README.md
```

## Platform Support Matrix

| Feature | Linux | macOS | Windows |
|---------|-------|-------|---------|
| Filesystem Isolation | ✅ Namespaces | ✅ Seatbelt | ✅ AppContainer |
| Process Isolation | ✅ PID NS | ✅ Seatbelt | ✅ Job Objects |
| Network Isolation | ✅ Net NS | ⚠️ NEFilterProvider | ✅ Job Objects |
| CPU Limits | ✅ cgroups v2 | ⚠️ Limited | ✅ Job Objects |
| Memory Limits | ✅ cgroups v2 | ⚠️ Limited | ✅ Job Objects |
| Cleanup on Crash | ✅ | ✅ | ✅ |

## Quick Start

```bash
cd spikes/sandbox
npm install
npm run build

# Run tests (requires appropriate privileges)
npm test

# Run specific test
npx vitest run test-cases/filesystem-isolation.test.ts
```

## Usage

```typescript
import { SandboxManager, SandboxProfile } from './src';

const sandbox = new SandboxManager();

// Create strict sandbox
const handle = await sandbox.create({
  profile: 'strict',
  workspace: '/home/user/project',
  limits: {
    cpuPercent: 50,
    memoryMB: 2048,
    diskMB: 1024,
    processes: 10
  }
});

// Run command in sandbox
const result = await sandbox.run(handle.id, 'npm', ['test']);

// Cleanup
await sandbox.destroy(handle.id);
```

## Profiles

### Strict (Production AFK)
- Filesystem: Workspace only, deny all else
- Process: Allowlist only (git, npm, node, python, etc.)
- Network: Deny all
- Resources: Strict limits

### Standard (Interactive)
- Filesystem: Workspace + temp, deny secrets
- Process: Allowlist + common tools
- Network: Allow localhost only
- Resources: Moderate limits

### Permissive (Development)
- Filesystem: Workspace + home (read), deny .ssh/.aws
- Process: Denylist only (sudo, systemctl, docker)
- Network: Allow outbound
- Resources: Generous limits

## Linux Implementation Details

### Namespaces Used
- `CLONE_NEWPID` - Process ID isolation
- `CLONE_NEWNS` - Mount namespace (filesystem)
- `CLONE_NEWNET` - Network isolation
- `CLONE_NEWUSER` - User namespace (rootless)
- `CLONE_NEWIPC` - IPC isolation
- `CLONE_NEWUTS` - Hostname isolation

### Cgroups v2 Configuration
```bash
# Create cgroup
mkdir -p /sys/fs/cgroup/freebuff/sandbox_<id>

# CPU limit (50%)
echo 50000 > /sys/fs/cgroup/freebuff/sandbox_<id>/cpu.max

# Memory limit (2GB)
echo 2147483648 > /sys/fs/cgroup/freebuff/sandbox_<id>/memory.max

# Process limit
echo 10 > /sys/fs/cgroup/freebuff/sandbox_<id>/pids.max

# Add process
echo <PID> > /sys/fs/cgroup/freebuff/sandbox_<id>/cgroup.procs
```

## macOS Implementation Details

### Seatbelt Profile (sandbox-exec)
```scheme
(version 1)
(deny default)
(allow file-read* (regex #"^/home/user/project/.*"))
(allow file-write* (regex #"^/home/user/project/.*"))
(allow process-exec (regex #"^/usr/bin/(git|npm|node|python3)"))
(deny network-outbound)
(deny network-inbound)
```

## Windows Implementation Details

### Job Objects
```cpp
// Create job object
HANDLE job = CreateJobObject(nullptr, nullptr);

// CPU limit (50%)
JOBOBJECT_CPU_RATE_CONTROL_INFO cpuInfo = {0};
cpuInfo.ControlFlags = JOB_OBJECT_CPU_RATE_CONTROL_ENABLE | JOB_OBJECT_CPU_RATE_CONTROL_HARD_CAP;
cpuInfo.CpuRate = 5000; // 50% * 100
SetInformationJobObject(job, JobObjectCpuRateControlInformation, &cpuInfo, sizeof(cpuInfo));

// Memory limit (2GB)
JOBOBJECT_EXTENDED_LIMIT_INFO memInfo = {0};
memInfo.BasicLimitInfo.LimitFlags = JOB_OBJECT_LIMIT_PROCESS_MEMORY | JOB_OBJECT_LIMIT_JOB_MEMORY;
memInfo.ProcessMemoryLimit = 2147483648;
memInfo.JobMemoryLimit = 2147483648;
SetInformationJobObject(job, JobObjectExtendedLimitInformation, &memInfo, sizeof(memInfo));

// Assign process
AssignProcessToJobObject(job, processHandle);
```

### AppContainer (Filesystem)
```powershell
# Create AppContainer profile
New-AppContainerProfile -Name "FreebuffSandbox" -Description "Freebuff agent sandbox"

# Set filesystem capabilities
Set-AppContainerProfileAcl -Name "FreebuffSandbox" -Path "C:\project" -AccessRights "FullControl"
```

## Test Checklist

- [ ] Agent cannot read files outside project root
- [ ] Agent cannot access ~/.ssh, ~/.aws, ~/.env
- [ ] Agent cannot spawn processes outside sandbox
- [ ] CPU usage capped at configured limit
- [ ] Memory usage capped at configured limit
- [ ] Network blocked by default
- [ ] Agent can be terminated instantly (SIGKILL equivalent)
- [ ] Sandbox cleans up after crash (no orphan processes)
- [ ] Explicit project root enforced (no traversal)
- [ ] Multiple concurrent sandboxes work
- [ ] Nested sandbox prevention

## Security Considerations

1. **Rootless Operation**: Linux implementation uses user namespaces, no root required
2. **No Privilege Escalation**: Sandbox cannot escape to host privileges
3. **Immutable Profiles**: Profiles loaded at startup, not modifiable at runtime
4. **Audit Logging**: All sandbox operations logged for audit trail
5. **Fail-Safe Defaults**: Deny-by-default for all capabilities