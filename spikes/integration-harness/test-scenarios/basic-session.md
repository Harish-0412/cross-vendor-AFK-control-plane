# Basic Session Test Scenario

## Objective
Verify that the harness can start an agent, send a prompt, capture output, and stop cleanly.

## Steps
1. Detect agent availability
2. Start session with prompt: "Create a simple calculator function in TypeScript"
3. Stream and capture all events
4. Verify session completes successfully
5. Stop session
6. Verify cleanup (no orphan processes)

## Expected Events Sequence
```
1. session.started
2. assistant.thinking (planning phase)
3. assistant.message (initial response)
4. tool.call (file write)
5. tool.result (success)
6. file.write (confirmation)
7. assistant.message (completion summary)
8. session.completed
```

## Success Criteria
- Session starts within 5 seconds
- At least 5 events captured
- Final event is `session.completed` or `session.failed` (not crash)
- Process exits cleanly (exit code 0 or SIGINT)
- No orphan processes remain
- Workspace contains expected file output

## Mock Agent Configuration
```json
{
  "scenario": "basic",
  "delay": 100
}
```

## OpenCode Command
```bash
opencode run --headless --json --prompt "Create a simple calculator function in TypeScript" --approval-mode auto
```