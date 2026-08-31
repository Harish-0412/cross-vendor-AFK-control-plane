# OpenCode Agent Compatibility Analysis

## Overview
OpenCode is an open-source AI coding agent developed by the OpenCode team. It provides a CLI-first interface with headless operation support.

## Installation

### Binary Installation
```bash
# macOS (Homebrew)
brew install opencode-ai/tap/opencode

# Linux (curl)
curl -fsSL https://opencode.ai/install.sh | sh

# Windows (scoop)
scoop bucket add opencode-ai https://github.com/opencode-ai/scoop-bucket
scoop install opencode

# npm (cross-platform)
npm install -g @opencode-ai/opencode
```

### Binary Name
- `opencode` (primary)
- Available in PATH after installation

## CLI Availability

### Headless Mode
```bash
# Run in headless mode (no TUI)
opencode run --headless --prompt "Your task here"

# Non-interactive mode for automation
opencode run --non-interactive --prompt "Fix the bug in src/auth.ts"

# With JSON output for programmatic consumption
opencode run --headless --json --prompt "Refactor the user service"
```

### Key Command-Line Flags
| Flag | Description |
|------|-------------|
| `--headless` | Run without TUI, suitable for automation |
| `--non-interactive` | Exit after completing the prompt |
| `--json` | Output structured JSON events |
| `--prompt` | Initial prompt/task to execute |
| `--model` | Specify model (e.g., `gpt-4`, `claude-3-opus`) |
| `--config` | Path to config file |
| `--workspace` | Working directory |
| `--approval-mode` | Control approval behavior (`auto`, `ask`, `never`) |
| `--max-turns` | Maximum conversation turns |
| `--timeout` | Session timeout in seconds |

### Programmatic Input Mechanism
```bash
# Via stdin (for piping)
echo "Fix the authentication bug" | opencode run --headless --non-interactive

# Via --prompt flag
opencode run --headless --prompt "$(cat task.md)"

# Via config file with pre-defined tasks
opencode run --config .opencode/task-config.json
```

## Session Model

### Single Session
- Each `opencode run` invocation creates a single session
- Sessions are ephemeral by default (no built-in persistence across runs)

### Multiple Concurrent Sessions
- Multiple `opencode run` processes can run simultaneously
- Each process operates independently with its own working directory
- No built-in session sharing or coordination between processes

### State Persistence
- **Conversation history**: Stored in `.opencode/history/` within workspace
- **Session state**: Can be exported/imported via `--session-file` flag
- **Checkpointing**: Manual via `opencode session export/import`
- **No automatic resume**: Requires explicit session file management

## Event Model

### Event Emission
OpenCode emits structured events when run with `--json` flag:

```json
{
  "type": "event",
  "event": "message",
  "timestamp": "2026-08-31T10:00:00.000Z",
  "data": {
    "role": "assistant",
    "content": "I'll help you fix that bug...",
    "tool_calls": []
  }
}
```

### Event Types
| Event Type | Description | Payload |
|------------|-------------|---------|
| `session.start` | Session initialized | `{ sessionId, workspace, model }` |
| `message` | Assistant/user message | `{ role, content, tool_calls }` |
| `tool_call` | Tool invocation | `{ name, arguments, id }` |
| `tool_result` | Tool execution result | `{ toolCallId, output, error }` |
| `file_change` | File modification | `{ path, operation, diff }` |
| `approval_request` | Permission request | `{ tool, reason, risk }` |
| `session.complete` | Task finished | `{ exitCode, summary }` |
| `session.error` | Error occurred | `{ error, recoverable }` |
| `turn` | Conversation turn | `{ turnNumber, tokens }` |

### Subscription Mechanism
- **stdout**: JSON lines (one event per line) when `--json` flag used
- **No WebSocket/SSE**: Events only via stdout, no network event stream
- **No long-polling**: Single request-response per run

## Process Lifecycle

### Start
```bash
# Foreground process
opencode run --headless --prompt "Task"

# Background with PID capture
opencode run --headless --prompt "Task" &
OPENCODE_PID=$!
```

### Stop (Graceful)
```bash
# Send SIGINT (Ctrl+C equivalent)
kill -INT $OPENCODE_PID

# Or via stdin if interactive
echo "exit" | opencode run --headless
```

### Force Kill
```bash
kill -KILL $OPENCODE_PID
```

### Restart
- No native session resume without `--session-file`
- Must export session before stop, import on restart

### Exit Codes
| Code | Meaning |
|------|---------|
| 0 | Success / task completed |
| 1 | General error |
| 2 | Invalid arguments |
| 3 | Authentication/API error |
| 4 | Session cancelled by user |
| 5 | Timeout |
| 130 | Interrupted (SIGINT) |
| 137 | Killed (SIGKILL) |

## Approval Behavior

### Default Behavior
- **Interactive mode**: Prompts for approval on file writes, commands, network access
- **Headless mode**: `--approval-mode` flag controls behavior

### Approval Modes
| Mode | Behavior |
|------|----------|
| `ask` (default) | Prompt for each sensitive action |
| `auto` | Auto-approve all actions |
| `never` | Reject all sensitive actions (fail fast) |

### Interception Points
- File write operations (`write`, `edit`, `delete`)
- Shell command execution (`bash`, `exec`)
- Network requests (`fetch`, `http`)
- Git operations (`git commit`, `git push`)
- Package installation (`npm install`, `pip install`)

### Programmatic Approval Handling
- No native API for external approval interception
- Must use `--approval-mode=auto` for fully automated runs
- Custom approval logic requires forking/modifying OpenCode

## Output Streaming

### Real-time Output
- **stdout**: JSON event stream (with `--json`)
- **stderr**: Logs, warnings, errors
- **Buffering**: Line-buffered by default

### Output Formats
```bash
# JSON lines (structured)
opencode run --headless --json --prompt "Task"

# Plain text (human-readable)
opencode run --headless --prompt "Task"

# Minimal (only final result)
opencode run --headless --non-interactive --quiet --prompt "Task"
```

## Cancellation

### Mid-task Cancellation
- **SIGINT** (`kill -INT`): Graceful shutdown, saves session state
- **SIGTERM**: Attempts graceful shutdown
- **SIGKILL**: Immediate termination, no cleanup

### Cancellation Behavior
- Stops current tool execution
- Saves conversation history to `.opencode/history/`
- Returns exit code 130 (SIGINT) or 137 (SIGKILL)

## Diff Accessibility

### Git Integration
- **Native git awareness**: Detects git repository automatically
- **Diff output**: Shows diffs in tool results for file edits
- **Git operations**: Can run `git diff`, `git status`, `git commit` via shell tool
- **No built-in PR creation**: Requires shell commands or external tooling

### Diff Format
```json
{
  "type": "tool_result",
  "tool": "edit",
  "data": {
    "path": "src/auth.ts",
    "diff": "@@ -1,5 +1,6 @@\n import { User } from './types';\n+\n export function authenticate(token: string): User {\n   // ...\n }"
  }
}
```

## License & Terms

### License
- **MIT License** (as of 2024)
- Permits commercial use, modification, distribution
- Allows wrapper/automation tools

### Integration Restrictions
- No restrictions on building wrappers or automation
- Can be embedded in other applications
- Must preserve license notices

### Attribution
- Required: Include MIT license in distributed binaries
- Recommended: Link to https://opencode.ai

## Platform Support

| Platform | Support | Notes |
|----------|---------|-------|
| Linux | ✅ Full | Primary development target |
| macOS | ✅ Full | Intel & Apple Silicon |
| Windows | ✅ Full | Via WSL2 recommended; native via scoop |
| FreeBSD | ❓ Untested | Likely works (Node.js based) |

### Requirements
- **Node.js**: >= 18.0.0 (bundled in binary releases)
- **Memory**: Minimum 512MB, recommended 2GB+
- **Disk**: ~200MB for binary + workspace

## Version Stability

### Release Cadence
- **Frequency**: ~2-4 weeks
- **Versioning**: Semantic versioning (MAJOR.MINOR.PATCH)
- **Breaking changes**: Rare, documented in CHANGELOG

### API Stability
- **CLI flags**: Stable since v0.10+
- **JSON event format**: Stable since v0.12+
- **Config schema**: Stable, with migration tooling

### Compatibility Matrix
| OpenCode Version | JSON Events | Headless | Session Export | Approval Modes |
|------------------|-------------|----------|----------------|----------------|
| >= 0.15.x | ✅ | ✅ | ✅ | ✅ |
| 0.12.x - 0.14.x | ✅ | ✅ | ⚠️ Partial | ✅ |
| < 0.12.x | ❌ | ⚠️ Limited | ❌ | ❌ |

## Integration Assessment

### Strengths for Freebuff Integration
1. **Native headless mode** with JSON output
2. **Open source** (MIT) - no licensing barriers
3. **Active development** with stable CLI
4. **Explicit approval modes** for automation
5. **Session export/import** for checkpointing
6. **Git-aware** with diff output
7. **Cross-platform** with single binary

### Challenges
1. **No persistent daemon** - each run is a new process
2. **No native event streaming API** - only stdout JSON lines
3. **Session resume requires manual file handling**
4. **Approval interception not programmable** - only via modes
5. **No built-in sandboxing** - relies on OS/container isolation

### Recommended Adapter Approach
```
Adapter Strategy: Process Wrapper
- Spawn `opencode run --headless --json --prompt "..."` as child process
- Parse JSON lines from stdout for event normalization
- Use `--approval-mode=auto` for AFK, `--approval-mode=ask` for interactive
- Manage session files for checkpoint/resume
- Implement sandbox at OS level (not OpenCode level)
```

## Configuration Reference

### Config File (`.opencode/config.json`)
```json
{
  "model": "gpt-4",
  "approvalMode": "ask",
  "maxTurns": 50,
  "timeout": 300,
  "workspace": ".",
  "permissions": {
    "filesystem": "workspace",
    "shell": true,
    "network": false
  },
  "tools": {
    "enabled": ["read", "write", "edit", "bash", "grep", "glob", "task"],
    "disabled": []
  }
}
```

### Environment Variables
| Variable | Description |
|----------|-------------|
| `OPENCODE_API_KEY` | API key for model provider |
| `OPENCODE_MODEL` | Default model override |
| `OPENCODE_CONFIG` | Config file path |
| `OPENCODE_WORKSPACE` | Workspace directory |
| `NO_COLOR` | Disable colored output |

## Summary for Freebuff

| Capability | Support | Notes |
|------------|---------|-------|
| Headless CLI | ✅ Full | `--headless --json` |
| Programmatic input | ✅ Full | `--prompt`, stdin |
| Event streaming | ✅ JSON lines | Via stdout only |
| Session persistence | ⚠️ Partial | Manual export/import |
| Approval interception | ⚠️ Modes only | No callback API |
| Cancellation | ✅ Full | SIGINT/SIGTERM |
| Diff output | ✅ Full | In tool results |
| Git integration | ✅ Native | Repo detection, diffs |
| Sandboxing | ❌ None | External required |
| License | ✅ Permissive | MIT |

**Verdict**: Excellent first adapter candidate. Strong CLI, open license, good automation support. Main gap is session persistence and programmable approvals - both manageable in adapter layer.