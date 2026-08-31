# Crash Recovery Test Scenario

## Objective
Verify that the harness handles agent crashes gracefully and cleans up resources.

## Steps
1. Start session with prompt that will take time: "Analyze this codebase and create comprehensive documentation"
2. Wait for agent to begin processing (capture first few events)
3. Force kill the agent process (SIGKILL)
4. Verify harness detects termination
5. Verify no orphan processes remain
6. Verify session marked as crashed/cancelled
7. Attempt to restart harness and verify clean state

## Expected Events Sequence
```
1. session.started
2. assistant.thinking
3. assistant.message (starts analysis)
4. tool.call (read files)
5. tool.result
6. ... (several file reads)
7. [SIGKILL sent]
8. Process terminates
9. Harness captures exit code 137 (SIGKILL)
10. Session marked as crashed
```

## Success Criteria
- Harness detects process termination within 1 second
- Session status correctly set to 'crashed' or 'cancelled'
- No zombie/orphan processes
- Event buffer preserved up to crash point
- Harness can be reused for new sessions
- Workspace not corrupted

## Mock Agent Configuration
```json
{
  "scenario": "crash",
  "delay": 200,
  "crashAtTurn": 2
}
```

## OpenCode Test
```bash
# Start in background
opencode run --headless --json --prompt "Analyze codebase and create comprehensive documentation" --approval-mode auto &
PID=$!

# Wait for startup
sleep 2

# Force kill
kill -9 $PID

# Verify cleanup
sleep 1
ps aux | grep opencode  # Should not show the killed process
```