# Claude (Anthropic) Agent Compatibility Analysis

## Overview
Claude is Anthropic's AI assistant. The primary integration paths for coding agents are:
1. **Claude Code** - Official CLI tool (in preview/beta as of 2026)
2. **Claude API** - Build custom agents using the API
3. **Claude Desktop App** - Not suitable for automation

## Claude Code (Official CLI)

### Installation
```bash
# macOS (Homebrew) - when available
brew install anthropic/tap/claude-code

# Linux/macOS (installer)
curl -fsSL https://claude.ai/code/install.sh | sh

# Windows
winget install Anthropic.ClaudeCode

# npm (if published)
npm install -g @anthropic-ai/claude-code
```

### Binary Name
- `claude-code` or `claude` (TBD)

### Current Status (2026)
- **In preview/beta** - limited access
- **Requires Anthropic account** with API access
- **Authentication via API key** (`ANTHROPIC_API_KEY`)

## CLI Availability

### Headless Mode (Expected)
```bash
# Non-interactive execution
claude-code run --prompt "Fix the authentication bug"

# JSON output for automation
claude-code run --json --prompt "Refactor user service"

# With workspace specification
claude-code run --workspace /path/to/project --prompt "Task"
```

### Key Command-Line Flags (Expected)
| Flag | Description |
|------|-------------|
| `--prompt` / `-p` | Task/prompt to execute |
| `--json` | Structured JSON output |
| `--non-interactive` | Exit after completion |
| `--model` | Model (claude-3-opus, claude-3-sonnet, claude-3-haiku) |
| `--workspace` / `-w` | Working directory |
| `--approval-mode` | Permission handling |
| `--config` | Configuration file |
| `--session` | Session continuation |
| `--max-turns` | Conversation turn limit |
| `--timeout` | Execution timeout |

## Session Model

### Session Architecture
- **Local-first** with optional cloud sync
- **File-based session storage** in `.claude-code/sessions/`
- **Git-like history** for conversation branching

### State Persistence
- **Automatic**: Sessions saved locally after each turn
- **Resume**: `claude-code run --session <id> --prompt "Continue"`
- **Export/Import**: JSON session files
- **Branching**: `claude-code session fork <id>`

### Concurrent Sessions
- Multiple sessions per workspace
- Session isolation via unique IDs
- Shared workspace, separate histories

## Event Model

### Event Emission (Expected JSON Lines)
```json
{
  "type": "event",
  "event": "assistant_message",
  "timestamp": "2026-08-31T10:00:00.000Z",
  "session_id": "sess_abc123",
  "data": {
    "content": "I'll fix that bug...",
    "tool_use": [
      {
        "id": "tool_123",
        "name": "edit_file",
        "input": { "path": "src/auth.ts", "old_str": "...", "new_str": "..." }
      }
    ]
  }
}
```

### Expected Event Types
| Event Type | Description |
|------------|-------------|
| `session_start` | Session initialized |
| `user_message` | User prompt/input |
| `assistant_message` | Assistant response with tool use |
| `tool_use` | Tool invocation request |
| `tool_result` | Tool execution result |
| `file_read` | File read operation |
| `file_write` | File write operation |
| `file_edit` | File edit operation |
| `bash_command` | Shell command execution |
| `approval_request` | Permission needed |
| `session_end` | Session completed |
| `error` | Error occurred |

### Subscription Mechanism
- **stdout**: JSON lines (primary for automation)
- **No network events** - purely local execution

## Process Lifecycle

### Start
```bash
# New session
claude-code run --prompt "Task"

# Resume
claude-code run --session sess_abc123 --prompt "Continue"
```

### Stop
```bash
# Graceful: Ctrl+C (SIGINT)
# Auto-saves session state

# Force: SIGKILL
# Session recoverable from last save point
```

### Authentication
```bash
# API key (required)
export ANTHROPIC_API_KEY=sk-ant-...
claude-code run --prompt "Task"

# Config file with key
claude-code run --config claude-config.json --prompt "Task"
```

## Approval Behavior

### Approval Model
- **Local approval prompts** in interactive mode
- **Configurable approval modes** for automation
- **Tool-level granularity** (read vs write vs bash)

### Approval Modes (Expected)
| Mode | Behavior |
|------|----------|
| `ask` | Prompt for each tool use requiring approval |
| `auto` | Auto-approve based on config rules |
| `never` | Reject all approval-required tools |

### Configurable Approval Rules (Expected)
```json
{
  "approvals": {
    "bash": "ask",
    "file_write": "ask",
    "file_read": "auto",
    "network": "never",
    "git_push": "ask"
  }
}
```

### Programmatic Approval
- **No callback API** expected in MVP
- Rules-based via config file
- Future: Webhook/HTTP callback for external approval

## Output Streaming

### Real-time Output
- **stdout**: JSON event stream
- **stderr**: Logs, progress, errors

### Formats
```bash
# JSON lines (automation)
claude-code run --json --prompt "Task"

# Human-readable (interactive)
claude-code run --prompt "Task"

# Streaming text (no JSON)
claude-code run --stream --prompt "Task"
```

## Cancellation

### Mid-task Cancellation
- **SIGINT**: Graceful, saves session, returns partial results
- **SIGTERM**: Graceful shutdown
- **SIGKILL**: Immediate, session recoverable from last checkpoint

### Recovery
- Sessions auto-saved every N turns
- Resume from last checkpoint with `--session`

## Diff Accessibility

### Git Integration
- **Native git awareness**: Detects repo, respects `.gitignore`
- **Diff in tool results**: File edits include unified diffs
- **Git operations**: Via `bash` tool or native git commands
- **Commit/PR**: Through bash tool or future native integration

### Diff Format
```json
{
  "type": "tool_result",
  "tool": "edit_file",
  "tool_use_id": "tool_123",
  "result": {
    "path": "src/auth.ts",
    "diff": "@@ -15,7 +15,7 @@\n export function validate(token: string) {\n-    return jwt.verify(token, 'hardcoded-secret')\n+    return jwt.verify(token, process.env.JWT_SECRET)\n }"
  }
}
```

## License & Terms

### Claude Code CLI License
- **Likely proprietary** (Anthropic)
- **Terms of Service** apply
- **Commercial use** requires agreement

### API License (for custom agents)
- **Anthropic API Agreement**
- **Per-token pricing**
- **Data usage policy**: No training on API data (default)

### Integration Restrictions
| Aspect | CLI | Custom API Agent |
|--------|-----|------------------|
| Wrapper tools | Likely allowed | Allowed |
| Redistribution | Likely restricted | N/A (your code) |
| Self-hosting | Local binary | Your infrastructure |
| Offline use | ❌ No (API required) | ❌ No |
| Rate limits | API tier limits | API tier limits |

## Platform Support

| Platform | Support | Notes |
|----------|---------|-------|
| Linux | ✅ Planned | Native binary |
| macOS | ✅ Planned | Native binary (Intel + ARM) |
| Windows | ✅ Planned | Native binary |
| Docker | ✅ Expected | Container image |

### Requirements
- **Internet required**: API calls to Anthropic
- **API key**: Anthropic account with credits
- **Memory**: ~500MB+ for CLI + Node.js runtime

## Version Stability

### Release Model
- **CLI**: Versioned releases
- **API**: Versioned (2024-01-01, 2024-10-22, etc.)
- **Models**: Separate versioning (3.5 Sonnet, 3 Opus, etc.)

### Breaking Changes
- **CLI**: Possible during preview
- **API**: Versioned, 12-month deprecation policy
- **Event format**: May stabilize after beta

## Integration Assessment

### Strengths for Freebuff
1. **Local execution** - runs on developer's machine
2. **File-based sessions** - easy checkpoint/resume
3. **Configurable approvals** - rules-based, no callback needed
4. **Native git integration** - diffs, repo awareness
5. **Strong model quality** - Claude 3.5 Sonnet excellent for coding
6. **JSON event stream** - designed for automation

### Challenges
1. **API key required** - ongoing cost, not free
2. **Internet required** - no offline mode
3. **Proprietary** - vendor lock-in
4. **Rate limits** - may constrain AFK long-running tasks
5. **Preview/beta** - API may change
6. **No native sandboxing** - requires OS-level isolation

### Recommended Adapter Approach
```
Adapter Strategy: Process Wrapper (Primary)
- Spawn `claude-code run --json --prompt "..."` as child process
- Parse JSON lines from stdout
- Manage session files in `.claude-code/sessions/`
- Use config file for approval rules (auto/ask/never per tool)
- Implement sandbox at OS level (namespaces, containers)
- Handle API key via secure local storage (not in config)
```

## Custom Agent via Anthropic API

### Alternative: Build Our Own Agent
Since Freebuff controls the agent adapter layer, we could build a **custom Claude-powered agent** using the Anthropic API directly:

```typescript
// Custom agent implementation
class CustomClaudeAgent {
  private client: AnthropicClient;
  private tools: ToolRegistry;
  private sandbox: SandboxManager;
  
  async run(prompt: string): AsyncIterable<AgentEvent> {
    // Full control over:
    // - Tool definitions (exact Freebuff schema)
    // - Sandbox enforcement (pre-tool execution)
    // - Approval callbacks (our policy engine)
    // - Event format (exact Freebuff envelope)
    // - Session persistence (our checkpoint store)
    // - Cost control (token budgets, model selection)
  }
}
```

**Advantages**:
- Full control over event format, tools, sandbox, approvals
- No CLI parsing brittleness
- Exact Freebuff protocol compliance
- Can use cheaper models (Haiku) for simple tasks

**Disadvantages**:
- More development effort
- Need to implement agent loop, tool execution, context management
- Re-inventing what Claude Code already does

## Configuration Reference

### Expected Config (`.claude-code/config.json`)
```json
{
  "model": "claude-3-5-sonnet-20241022",
  "approvals": {
    "bash": "ask",
    "file_write": "ask",
    "file_read": "auto",
    "network": "never",
    "git_push": "ask"
  },
  "workspace": ".",
  "maxTurns": 50,
  "timeout": 300,
  "tools": {
    "enabled": ["read", "write", "edit", "bash", "grep", "glob", "task"],
    "customTools": []
  }
}
```

### Environment Variables
| Variable | Description |
|----------|-------------|
| `ANTHROPIC_API_KEY` | Required for API access |
| `CLAUDE_CODE_CONFIG` | Config file path |
| `CLAUDE_CODE_WORKSPACE` | Workspace directory |
| `ANTHROPIC_MODEL` | Default model override |

## Summary for Freebuff

| Capability | Support | Notes |
|------------|---------|-------|
| Headless CLI | ⚠️ Preview | Expected in beta |
| Programmatic input | ✅ Expected | `--prompt`, stdin |
| Event streaming | ✅ Expected | JSON lines via stdout |
| Session persistence | ✅ Local files | Auto-save, resume |
| Approval interception | ⚠️ Config only | Rules-based, no callback |
| Cancellation | ✅ Expected | SIGINT, checkpoint recovery |
| Diff output | ✅ Expected | In tool results |
| Git integration | ✅ Expected | Native repo awareness |
| Sandboxing | ❌ None | External required |
| License | ❌ Proprietary | Anthropic terms |
| Cost | ❌ Paid API | Per-token pricing |

**Verdict**: **Good candidate for Phase 8+ adapter**. Local execution model aligns with Freebuff. Main gaps: proprietary, paid API, no offline, beta status. 

**Recommendation**: 
1. Monitor Claude Code CLI release
2. Build adapter when CLI stabilizes (GA)
3. Consider custom API agent for full control (higher effort, better fit)
4. Document cost model clearly for users

## Comparison: OpenCode vs Claude Code for Freebuff

| Factor | OpenCode | Claude Code |
|--------|----------|-------------|
| License | MIT (open) | Proprietary |
| Cost | Free (BYOK) | Paid API |
| Offline | ❌ No (needs API) | ❌ No (needs API) |
| Local execution | ✅ Yes | ✅ Yes |
| Session persistence | Manual export/import | Auto local files |
| Approval control | Modes only | Config rules |
| Event format | JSON lines | JSON lines (expected) |
| Sandboxing | External | External |
| Maturity | Released | Preview |
| Model quality | BYOK (GPT-4, etc.) | Claude 3.5 Sonnet |

**Freebuff Priority**: OpenCode first (open, free, released), Claude Code second (when GA).