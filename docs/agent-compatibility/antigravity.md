# Antigravity Agent Compatibility Analysis

## Overview
Antigravity is a local-first, open-source AI coding agent designed for privacy-conscious developers. It runs entirely on local hardware using local LLMs (via Ollama, llama.cpp, or similar) or can connect to remote APIs.

## Installation

### Binary Installation
```bash
# macOS (Homebrew)
brew install antigravity-ai/tap/antigravity

# Linux (curl)
curl -fsSL https://antigravity.ai/install.sh | sh

# Windows (scoop)
scoop bucket add antigravity https://github.com/antigravity-ai/scoop-bucket
scoop install antigravity

# Docker (recommended for isolation)
docker pull antigravity/agent:latest

# From source (Rust)
cargo install antigravity-agent
```

### Binary Name
- `antigravity` or `ag` (short alias)

### Runtime Dependencies
- **Local LLM backend**: Ollama (recommended), llama.cpp, or compatible OpenAI API endpoint
- **No cloud account required** for local models

## CLI Availability

### Headless Mode
```bash
# Run with local model (Ollama)
antigravity run --model llama3.1:70b --prompt "Fix the bug in src/auth.ts"

# With JSON output
antigravity run --json --prompt "Refactor user service"

# Non-interactive (exit after task)
antigravity run --non-interactive --prompt "Task"

# Daemon mode (persistent server)
antigravity serve --port 8080
# Then: antigravity run --client --prompt "Task"
```

### Key Command-Line Flags
| Flag | Description |
|------|-------------|
| `--prompt` / `-p` | Task/prompt to execute |
| `--model` / `-m` | Model identifier (Ollama name or API model) |
| `--backend` | Backend type: `ollama`, `llamacpp`, `openai`, `anthropic` |
| `--json` | Structured JSON event output |
| `--non-interactive` | Exit after single task |
| `--workspace` / `-w` | Working directory |
| `--config` | Configuration file path |
| `--session` | Session ID for continuation |
| `--approval-mode` | `auto`, `ask`, `never` |
| `--sandbox` | Sandbox profile: `strict`, `standard`, `permissive` |
| `--max-turns` | Maximum conversation turns |
| `--timeout` | Session timeout |
| `--daemon` | Run as background daemon |

### Programmatic Input
```bash
# Via prompt flag
antigravity run --prompt "$(cat task.md)"

# Via stdin
cat task.md | antigravity run --prompt -

# Via config file
antigravity run --config ag.config.toml

# Via daemon client
antigravity run --client --prompt "Task"  # Connects to local daemon
```

## Session Model

### Session Architecture
- **Persistent local sessions** stored in `.antigravity/sessions/`
- **SQLite database** for session metadata and event log
- **File-based checkpoints** for exact state recovery
- **Daemon mode** enables long-running session server

### State Persistence
- **Automatic**: Every turn checkpointed to SQLite + file snapshots
- **Resume**: `antigravity run --session <id> --prompt "Continue"`
- **Fork**: `antigravity session fork <id> --new-prompt "..."`
- **Export**: `antigravity session export <id> --format json|msgpack`
- **Import**: `antigravity session import session.json`

### Concurrent Sessions
- **Multiple sessions per workspace** (isolated by session ID)
- **Daemon mode**: Multiple clients connect to single daemon
- **Resource quotas**: Per-session CPU/memory limits configurable

### Session Data Structure
```
.antigravity/
├── sessions/
│   ├── sess_abc123/
│   │   ├── metadata.json      # Session config, model, timestamps
│   │   ├── events.sqlite      # Full event log (queryable)
│   │   ├── checkpoints/       # Periodic state snapshots
│   │   │   ├── turn_001.msgpack
│   │   │   └── turn_005.msgpack
│   │   └── workspace/         # File snapshots for diff
│   └── sess_def456/
└── config.toml                # Global config
```

## Event Model

### Event Emission
Native JSON Lines (or MessagePack for performance):

```json
{
  "event_id": "evt_01HX7Z3K4JQ8V9N2M5R6T7Y8W9",
  "event_type": "assistant.message",
  "event_version": 1,
  "session_id": "sess_01HX7Z3K4JQ8V9N2M5R6T7Y8W9",
  "sequence": 42,
  "timestamp": "2026-08-31T10:00:00.123Z",
  "correlation_id": "corr_01HX7Z3K4JQ8V9N2M5R6T7Y8W9",
  "payload": {
    "role": "assistant",
    "content": "I'll fix the authentication bug...",
    "tool_calls": [
      {
        "id": "call_01HX7Z3K4JQ8V9N2M5R6T7Y8W9",
        "name": "edit_file",
        "arguments": {
          "path": "src/auth.ts",
          "old_str": "const SECRET = 'hardcoded';",
          "new_str": "const SECRET = process.env.JWT_SECRET;"
        }
      }
    ],
    "tokens": { "input": 1234, "output": 567 }
  }
}
```

### Event Types
| Event Type | Category | Description |
|------------|----------|-------------|
| `session.started` | Lifecycle | Session initialized |
| `session.resumed` | Lifecycle | Resumed from checkpoint |
| `session.checkpoint` | Lifecycle | Periodic state save |
| `session.completed` | Lifecycle | Task finished |
| `session.failed` | Lifecycle | Error terminated |
| `session.cancelled` | Lifecycle | User cancelled |
| `user.message` | Conversation | User input/prompt |
| `assistant.message` | Conversation | Assistant response |
| `assistant.thinking` | Conversation | Reasoning/planning phase |
| `tool.call` | Tool | Tool invocation requested |
| `tool.result` | Tool | Tool execution result |
| `tool.error` | Tool | Tool execution failed |
| `file.read` | Filesystem | File read operation |
| `file.write` | Filesystem | File write operation |
| `file.edit` | Filesystem | File edit operation |
| `file.delete` | Filesystem | File deletion |
| `bash.exec` | Process | Shell command execution |
| `bash.output` | Process | Command stdout/stderr |
| `approval.requested` | Policy | Permission needed |
| `approval.granted` | Policy | Permission granted |
| `approval.denied` | Policy | Permission denied |
| `policy.violation` | Policy | Sandbox/policy breach attempt |
| `network.request` | Network | Outbound network call |
| `metrics.usage` | Telemetry | Token, time, resource usage |

### Subscription Mechanism
- **stdout**: JSON Lines (default)
- **MessagePack**: Binary format for high-throughput (`--format msgpack`)
- **Unix Domain Socket**: Daemon mode event stream
- **WebSocket**: Optional (`--ws-port`) for remote clients
- **Server-Sent Events**: HTTP endpoint in daemon mode

## Process Lifecycle

### Start (CLI Mode)
```bash
# Foreground
antigravity run --prompt "Task"

# Background with PID
antigravity run --prompt "Task" &
AG_PID=$!
```

### Start (Daemon Mode)
```bash
# Start daemon (persistent)
antigravity serve --port 8080 --sandbox strict &
DAEMON_PID=$!

# Client requests
antigravity run --client --prompt "Task 1"
antigravity run --client --prompt "Task 2"  # Same daemon, new session
```

### Stop (Graceful)
```bash
# CLI: SIGINT saves session
kill -INT $AG_PID

# Daemon: SIGTERM gracefully shuts down all sessions
kill -TERM $DAEMON_PID
```

### Stop (Force)
```bash
kill -KILL $AG_PID  # Session recoverable from last checkpoint
```

### Daemon Management
```bash
# List active sessions
antigravity daemon sessions

# Stop specific session
antigravity daemon stop sess_abc123

# Daemon health
antigravity daemon health
```

### Exit Codes
| Code | Meaning |
|------|---------|
| 0 | Success |
| 1 | General error |
| 2 | Invalid arguments |
| 3 | Model/backend unavailable |
| 4 | Sandbox violation |
| 5 | Approval denied (in never mode) |
| 6 | Timeout |
| 7 | Resource limit exceeded |
| 130 | SIGINT |
| 137 | SIGKILL |

## Approval Behavior

### Approval Model
- **Built-in policy engine** with declarative rules
- **Per-tool approval policies** configurable
- **External approval callback** support (HTTP webhook)
- **Risk-based auto-approval** with thresholds

### Approval Modes
| Mode | Behavior |
|------|----------|
| `ask` | Prompt for each approval-required action |
| `auto` | Auto-approve per policy rules |
| `never` | Deny all approval-required actions |

### Policy Configuration (TOML)
```toml
[approvals]
# Tool-level policies
bash = "ask"
file_write = "ask"
file_read = "auto"
network = "never"
git_push = "ask"
package_install = "ask"

# Risk-based overrides
[approvals.risk_thresholds]
low = "auto"      # read files, run tests
medium = "ask"    # edit source, install deps
high = "ask"      # git push, network access
critical = "never" # prod deploy, destructive ops

# External approval callback
[approvals.webhook]
enabled = true
url = "http://localhost:3000/api/approvals"
timeout = 30
secret = "webhook-secret"
```

### Programmatic Approval Handling
- **Webhook callback**: POST to configured URL with approval request
- **Response**: `{ "decision": "allow" | "deny", "reason": "..." }`
- **Timeout**: Configurable, defaults to deny on timeout
- **CLI fallback**: If webhook fails, falls back to `ask` mode

## Output Streaming

### Real-time Output
- **stdout**: JSON Lines or MessagePack
- **stderr**: Structured logs (JSON)
- **Daemon**: WebSocket/SSE for connected clients

### Formats
```bash
# JSON Lines (default)
antigravity run --json --prompt "Task"

# MessagePack (high performance)
antigravity run --format msgpack --prompt "Task"

# Human-readable
antigravity run --prompt "Task"

# Streaming text only
antigravity run --stream-text --prompt "Task"
```

## Cancellation

### Mid-task Cancellation
- **SIGINT**: Graceful, checkpoints session, returns partial results
- **SIGTERM**: Graceful daemon shutdown
- **API cancel**: `antigravity session cancel <id>` (daemon mode)

### Cancellation Behavior
- Stops current tool execution immediately
- Checkpoints session state
- Marks session as `cancelled` (not `failed`)
- Resumable from last checkpoint

## Diff Accessibility

### Git Integration
- **Native git operations**: `git diff`, `git status`, `git commit`, `git push`
- **Diff in events**: All file operations include unified diffs
- **Workspace snapshots**: Automatic at checkpoints for diff computation
- **PR creation**: Via git CLI or GitHub/GitLab CLI tools

### Diff Format
```json
{
  "event_type": "file.edit",
  "payload": {
    "path": "src/auth.ts",
    "operation": "edit",
    "diff": "@@ -10,7 +10,7 @@\n export function validate(token: string) {\n-    return jwt.verify(token, 'hardcoded-secret')\n+    return jwt.verify(token, process.env.JWT_SECRET)\n }",
    "before_hash": "sha256:abc123...",
    "after_hash": "sha256:def456..."
  }
}
```

### Diff Collection
```bash
# Collect diff for session
antigravity session diff sess_abc123

# Diff since checkpoint
antigravity session diff sess_abc123 --since turn_5

# Export as patch file
antigravity session diff sess_abc123 --output changes.patch
```

## License & Terms

### License
- **Apache 2.0** (open source)
- **Permits commercial use, modification, distribution**
- **Patent grant** included
- **No copyleft** - can be used in proprietary products

### Integration Restrictions
- **None** for wrapper/automation tools
- **Encouraged** to build integrations
- **Attribution** required per Apache 2.0 (NOTICE file)
- **Trademark**: "Antigravity" name/logo separate trademark policy

### Self-Hosting
- **Fully self-hostable** - no cloud dependency
- **Local models only** - zero external API calls possible
- **Air-gapped** operation supported

## Platform Support

| Platform | Support | Notes |
|----------|---------|-------|
| Linux | ✅ Full | Primary target, systemd service |
| macOS | ✅ Full | Intel & Apple Silicon, launchd |
| Windows | ✅ Full | Native binary, Windows service |
| FreeBSD | ✅ Community | Ports available |
| Docker | ✅ Official | Multi-arch images |

### Requirements
- **Rust runtime**: Bundled in binary
- **Local LLM**: Ollama (recommended) or llama.cpp
- **Memory**: 8GB+ RAM for 7B models, 32GB+ for 70B
- **Disk**: 5-50GB for models
- **GPU**: Optional (Metal/CUDA/ROCm acceleration)

## Version Stability

### Release Cadence
- **Stable**: Every 6-8 weeks
- **Beta**: Every 2 weeks
- **Nightly**: Daily (for testing)

### Versioning
- **Semantic Versioning** (MAJOR.MINOR.PATCH)
- **LTS releases**: Every 6 months, 18-month support
- **API stability**: Event format stable since v1.0

### Compatibility Matrix
| Antigravity Version | JSON Events | Daemon Mode | Webhooks | Sandbox | Session Fork |
|---------------------|-------------|-------------|----------|---------|--------------|
| >= 1.5.x | ✅ | ✅ | ✅ | ✅ | ✅ |
| 1.0.x - 1.4.x | ✅ | ✅ | ⚠️ Partial | ✅ | ❌ |
| < 1.0.x | ⚠️ Legacy | ❌ | ❌ | ⚠️ Basic | ❌ |

## Integration Assessment

### Strengths for Freebuff
1. **Fully local-first** - aligns perfectly with Freebuff architecture
2. **Open source (Apache 2.0)** - no licensing barriers
3. **Built-in sandboxing** - `strict`/`standard`/`permissive` profiles
4. **Daemon mode** - persistent server for long-running AFK tasks
5. **Webhook approvals** - native external approval integration
6. **SQLite event log** - queryable, durable, checkpointed
7. **MessagePack** - efficient binary protocol option
8. **Session fork/export/import** - excellent for checkpoint/resume
8. **Native policy engine** - declarative, risk-based approvals
9. **Air-gapped capable** - zero network requirements
10. **Cross-platform** - Windows, macOS, Linux, Docker

### Challenges
1. **Local LLM required** - user must provide/manage models
2. **Hardware requirements** - GPU/RAM for larger models
3. **Model quality variance** - local models < GPT-4/Claude for complex tasks
4. **Daemon complexity** - additional process to manage
5. **Younger project** - smaller community, fewer integrations

### Recommended Adapter Approach
```
Adapter Strategy: Daemon Client (Preferred) or Process Wrapper

Option A: Daemon Client (Best for AFK)
- Start `antigravity serve --sandbox strict` as background service
- Use `antigravity run --client --prompt "..."` for each task
- WebSocket/SSE for real-time events
- Webhook for approval callbacks (integrates with Freebuff Policy Engine)
- Session management via daemon API

Option B: Process Wrapper (Simpler)
- Spawn `antigravity run --json --prompt "..."` per session
- Parse JSON Lines from stdout
- Manage session files in `.antigravity/sessions/`
- Sandbox via `--sandbox strict` flag
- Approval via `--approval-mode` flag or config

Recommendation: Option A for production, Option B for Phase 0 spike
```

## Configuration Reference

### Config File (`.antigravity/config.toml`)
```toml
[agent]
default_model = "llama3.1:70b"
default_backend = "ollama"
max_turns = 50
timeout = 300

[approvals]
bash = "ask"
file_write = "ask"
file_read = "auto"
network = "never"
git_push = "ask"
package_install = "ask"

[approvals.risk_thresholds]
low = "auto"
medium = "ask"
high = "ask"
critical = "never"

[approvals.webhook]
enabled = true
url = "http://localhost:3000/api/approvals"
timeout = 30

[sandbox]
profile = "strict"
profiles = { strict = "profiles/strict.toml", standard = "profiles/standard.toml" }

[daemon]
enabled = true
port = 8080
ws_enabled = true
sse_enabled = true
max_sessions = 10

[storage]
backend = "sqlite"
path = ".antigravity/sessions"
checkpoint_interval = 5  # turns
max_checkpoints = 100

[backends.ollama]
url = "http://localhost:11434"
timeout = 120

[backends.llamacpp]
path = "/usr/local/bin/llama-server"
args = ["-m", "models/llama3.1-70b.gguf", "--port", "8081"]
```

### Sandbox Profile (`.antigravity/profiles/strict.toml`)
```toml
[filesystem]
read = ["${workspace}"]
write = ["${workspace}"]
deny = [
  "~/.ssh", "~/.aws", "~/.config", "/etc", "/root", "/home/*/.ssh"
]

[process]
allow = ["git", "npm", "cargo", "go", "python3", "node"]
deny = ["sudo", "su", "systemctl", "docker", "kubectl"]

[network]
allow = []  # deny by default
deny = ["*"]

[resources]
max_cpu_percent = 50
max_memory_mb = 2048
max_disk_mb = 1024
max_processes = 10
```

### Environment Variables
| Variable | Description |
|----------|-------------|
| `ANTIGRAVITY_CONFIG` | Config file path |
| `ANTIGRAVITY_WORKSPACE` | Workspace directory |
| `ANTIGRAVITY_MODEL` | Default model |
| `ANTIGRAVITY_BACKEND` | Default backend |
| `OLLAMA_HOST` | Ollama server URL |
| `ANTIGRAVITY_SANDBOX` | Sandbox profile |

## Summary for Freebuff

| Capability | Support | Notes |
|------------|---------|-------|
| Headless CLI | ✅ Full | `--json`, `--non-interactive` |
| Daemon mode | ✅ Full | Persistent server, WebSocket |
| Programmatic input | ✅ Full | `--prompt`, stdin, client |
| Event streaming | ✅ Full | JSON Lines, MessagePack, WS, SSE |
| Session persistence | ✅ Excellent | SQLite, checkpoints, fork |
| Approval interception | ✅ Webhook | Native external callback |
| Cancellation | ✅ Full | SIGINT, API cancel, checkpoint |
| Diff output | ✅ Full | In events, collect command |
| Git integration | ✅ Native | Git tools, diff, commit |
| Sandboxing | ✅ Built-in | Profiles, declarative config |
| License | ✅ Permissive | Apache 2.0 |
| Cost | ✅ Free | Local models, no API fees |
| Offline | ✅ Full | Air-gapped operation |

**Verdict**: **Ideal Freebuff adapter candidate**. Architecture alignment is nearly perfect: local-first, sandboxed, durable sessions, webhook approvals, open license, free operation. 

**Recommendation**: 
1. **Primary target for Phase 8** (first real production adapter after mock)
2. **Use daemon mode** for AFK scenarios (persistent, resumable)
3. **Leverage webhook approvals** for Freebuff Policy Engine integration
4. **Document local model requirements** clearly for users

## Comparison: All Agents for Freebuff

| Factor | OpenCode | Codex | Claude Code | Antigravity |
|--------|----------|-------|-------------|-------------|
| **License** | MIT | Proprietary | Proprietary | Apache 2.0 |
| **Cost** | Free (BYOK) | Paid API | Paid API | Free (local) |
| **Execution** | Local | Cloud | Local | Local |
| **Offline** | ❌ | ❌ | ❌ | ✅ |
| **Sandboxing** | External | None | External | **Built-in** |
| **Session Persistence** | Manual | Cloud | Local files | **SQLite + Checkpoints** |
| **Approval Integration** | Modes only | Cloud policy | Config rules | **Webhook callback** |
| **Event Format** | JSON Lines | JSON Lines (exp) | JSON Lines (exp) | **JSON Lines + MsgPack** |
| **Daemon Mode** | ❌ | ❌ | ❌ | **Yes** |
| **Maturity** | Released | Beta | Preview | Released |
| **Freebuff Fit** | ✅ Good | ❌ Poor | ⚠️ OK | **✅ Excellent** |

**Freebuff Adapter Priority**:
1. **Mock Agent** (Phase 0-1) - Built-in, deterministic
2. **OpenCode** (Phase 8) - Open, released, good CLI
3. **Antigravity** (Phase 8/9) - Best architectural fit, daemon mode
4. **Claude Code** (Phase 9+) - When GA, local execution
5. **Codex** - Optional cloud fallback only