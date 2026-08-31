# Codex Agent Compatibility Analysis

## Overview
Codex is OpenAI's AI coding agent, currently available as a CLI tool (`codex`) and via the ChatGPT interface. The CLI is in active development.

## Installation

### Binary Installation
```bash
# macOS (Homebrew) - if available
brew install codex

# Linux/macOS (curl installer)
curl -fsSL https://codex.openai.com/install.sh | sh

# Windows (winget)
winget install OpenAI.Codex

# npm (if published)
npm install -g @openai/codex
```

### Binary Name
- `codex` (primary)

### Current Status (as of 2026)
- **CLI in beta/preview** - not generally available
- **Access requires OpenAI account** with Codex access
- **Authentication via OpenAI API key** or OAuth

## CLI Availability

### Headless Mode
```bash
# Run in headless/non-interactive mode
codex run --prompt "Fix the bug in src/auth.ts"

# With JSON output
codex run --json --prompt "Refactor the user service"

# Batch mode for multiple prompts
codex run --batch prompts.json
```

### Key Command-Line Flags (Expected)
| Flag | Description |
|------|-------------|
| `--prompt` / `-p` | Initial prompt/task |
| `--json` | Structured JSON output |
| `--non-interactive` | Exit after task completion |
| `--model` | Model selection (gpt-4, gpt-4o, etc.) |
| `--workspace` / `-w` | Working directory |
| `--approval-mode` | Auto/ask/never for approvals |
| `--config` | Configuration file path |
| `--session` | Session ID for continuation |
| `--timeout` | Maximum execution time |

### Programmatic Input
```bash
# Via prompt flag
codex run --prompt "$(cat task.md)"

# Via stdin
cat task.md | codex run --prompt -

# Via config file
codex run --config codex.config.json
```

## Session Model

### Session Architecture
- **Persistent sessions** via session IDs
- **Cloud-backed** session storage (OpenAI servers)
- **Local cache** for offline/resume capability
- **Multi-device session sync** via OpenAI account

### State Persistence
- **Automatic**: Sessions saved to OpenAI cloud
- **Resume**: `codex run --session <id>` continues previous session
- **Export**: `codex session export <id> > session.json`
- **Import**: `codex session import session.json`

### Concurrent Sessions
- Multiple sessions per account
- Session isolation by project/workspace
- Resource quotas per account tier

## Event Model

### Event Emission
Expected JSON event stream (based on OpenAI API patterns):

```json
{
  "id": "evt_abc123",
  "type": "message",
  "timestamp": "2026-08-31T10:00:00.000Z",
  "session_id": "sess_xyz789",
  "data": {
    "role": "assistant",
    "content": "I'll fix that bug...",
    "tool_calls": [
      {
        "id": "call_123",
        "type": "function",
        "function": {
          "name": "edit_file",
          "arguments": "{\"path\": \"src/auth.ts\", \"changes\": [...]}"
        }
      }
    ]
  }
}
```

### Expected Event Types
| Event Type | Description |
|------------|-------------|
| `session.created` | New session initialized |
| `message` | Assistant message with optional tool calls |
| `tool_call` | Function/tool invocation |
| `tool_result` | Tool execution result |
| `file_operation` | File read/write/edit/delete |
| `approval_request` | Permission needed for sensitive action |
| `session.completed` | Task finished successfully |
| `session.failed` | Error occurred |
| `token_usage` | Token consumption update |

### Subscription Mechanism
- **stdout**: JSON lines when `--json` flag used
- **Potential WebSocket**: For real-time cloud sync (unconfirmed)
- **Server-sent events**: Possible for long-running sessions

## Process Lifecycle

### Start
```bash
# New session
codex run --prompt "Task"

# Resume session
codex run --session sess_abc123 --prompt "Continue"
```

### Stop
```bash
# Graceful: Ctrl+C or SIGINT
# Session auto-saved to cloud

# Force: SIGKILL
# Session state preserved in cloud
```

### Authentication
```bash
# API key authentication
export OPENAI_API_KEY=sk-...
codex run --prompt "Task"

# OAuth (browser flow)
codex auth login
```

## Approval Behavior

### Approval Model
- **Cloud-enforced** approvals for sensitive operations
- **Local approval prompts** in interactive mode
- **Policy-based** via OpenAI dashboard (enterprise)

### Approval Modes (Expected)
| Mode | Behavior |
|------|----------|
| `ask` | Prompt for each sensitive action |
| `auto` | Auto-approve within policy limits |
| `never` | Reject all sensitive actions |

### Sensitive Actions Requiring Approval
- File writes outside workspace
- Shell command execution
- Network requests
- Git push/force push
- Package installation
- Secret access

### Programmatic Approval
- **No local callback API** expected
- Approval policies managed in OpenAI dashboard
- Webhook callbacks for enterprise (unconfirmed)

## Output Streaming

### Real-time Output
- **stdout**: JSON event stream
- **stderr**: Diagnostics, warnings
- **Cloud sync**: Events also sent to OpenAI servers

### Formats
```bash
# JSON lines
codex run --json --prompt "Task"

# Human-readable
codex run --prompt "Task"

# Minimal
codex run --quiet --prompt "Task"
```

## Cancellation

### Mid-task Cancellation
- **SIGINT**: Graceful, saves session state to cloud
- **SIGTERM**: Graceful shutdown
- **SIGKILL**: Immediate, cloud state preserved

### Cloud Session Recovery
- Sessions recoverable from any device
- `codex run --session <id>` resumes from last checkpoint

## Diff Accessibility

### Git Integration
- **Workspace git awareness**: Detects repo, shows status
- **Diff output**: In file operation events
- **Git operations**: Via shell tool or native git integration
- **PR creation**: Likely via GitHub integration (enterprise)

### Expected Diff Format
```json
{
  "type": "file_operation",
  "operation": "edit",
  "path": "src/auth.ts",
  "diff": "@@ -10,7 +10,7 @@\n function validate(token) {\n-  return jwt.verify(token, SECRET)\n+  return jwt.verify(token, process.env.JWT_SECRET)\n }"
}
```

## License & Terms

### License
- **Proprietary** (OpenAI)
- **Terms of Service** govern usage
- **API Agreement** for programmatic access

### Integration Restrictions
| Restriction | Details |
|-------------|---------|
| Commercial use | Requires OpenAI commercial agreement |
| Rate limits | Tier-based (requests/min, tokens/day) |
| Data usage | OpenAI may use data for training (opt-out available) |
| Wrapper tools | Allowed per API terms, but no reverse engineering |
| Redistribution | Binary redistribution likely prohibited |
| Self-hosting | Not available - cloud only |

### Attribution
- Required: "Powered by OpenAI Codex"
- API branding guidelines apply

## Platform Support

| Platform | Support | Notes |
|----------|---------|-------|
| Linux | ✅ Planned | Via binary/installer |
| macOS | ✅ Planned | Native binary |
| Windows | ✅ Planned | Native binary |
| Web | ✅ Current | ChatGPT interface |

### Requirements
- **Internet required**: Cloud-backed execution
- **OpenAI account**: With Codex access
- **API key**: For programmatic access

## Version Stability

### Release Model
- **Cloud service**: Continuous deployment
- **CLI binary**: Versioned releases
- **API**: Versioned (v1, v2, etc.)

### Breaking Changes
- **CLI**: Possible during beta
- **API**: Versioned, with deprecation policy
- **Event format**: May evolve during beta

## Integration Assessment

### Strengths for Freebuff Integration
1. **Cloud session persistence** - built-in resume/sync
2. **Enterprise features** - policies, audit, SSO
3. **Managed infrastructure** - no local compute needed
4. **Strong model quality** - GPT-4o, o1 models

### Major Challenges for Freebuff
1. **Cloud-only execution** - violates local-first architecture
2. **Proprietary** - no source access, vendor lock-in
3. **Network dependency** - cannot work offline
4. **Data leaves machine** - conflicts with redaction/sandbox goals
5. **No local sandbox control** - execution in OpenAI environment
6. **Cost** - per-token pricing, not free
7. **Rate limits** - may block AFK long-running tasks
8. **No local approval interception** - cloud-controlled

### Freebuff Architecture Conflict
```
Freebuff Requirement          Codex Reality
─────────────────────         ─────────────
Local execution               Cloud execution
Sandbox control               No local sandbox
Data never leaves machine     Data sent to OpenAI
Free/self-hosted              Paid cloud service
Offline capable               Online only
Programmable approvals        Cloud policy only
```

### Recommended Approach
**Do not integrate as primary adapter** for Freebuff MVP.

**Alternative**: 
- Use as *cloud fallback* when local agents unavailable
- Implement as *optional* adapter for users who prefer cloud
- Document architecture mismatch clearly

## Configuration Reference

### Expected Config (`.codex/config.json`)
```json
{
  "model": "gpt-4o",
  "approvalMode": "ask",
  "workspace": ".",
  "permissions": {
    "filesystem": "workspace",
    "shell": true,
    "network": "restricted"
  },
  "session": {
    "persist": true,
    "cloudSync": true
  }
}
```

### Environment Variables
| Variable | Description |
|----------|-------------|
| `OPENAI_API_KEY` | Required for authentication |
| `OPENAI_ORG_ID` | Organization ID (enterprise) |
| `CODEX_CONFIG` | Config file path |
| `CODEX_WORKSPACE` | Workspace directory |

## Summary for Freebuff

| Capability | Support | Notes |
|------------|---------|-------|
| Headless CLI | ⚠️ Beta | Limited availability |
| Programmatic input | ✅ Expected | `--prompt`, stdin |
| Event streaming | ⚠️ Expected | JSON lines via stdout |
| Session persistence | ✅ Cloud | Automatic, cloud-backed |
| Approval interception | ❌ None | Cloud policy only |
| Cancellation | ✅ Expected | SIGINT, cloud recovery |
| Diff output | ✅ Expected | In file events |
| Git integration | ⚠️ Partial | Via shell tool |
| Sandboxing | ❌ None | Cloud execution |
| License | ❌ Proprietary | OpenAI terms |

**Verdict**: **Not suitable for Freebuff core architecture**. Fundamental mismatch with local-first, sandboxed, vendor-neutral design. Could be an optional "cloud mode" adapter post-MVP for users who explicitly choose cloud execution.

**Recommendation**: Document as "architecturally incompatible" in compatibility matrix. Focus on local-first agents (OpenCode, Claude CLI, local LLMs).