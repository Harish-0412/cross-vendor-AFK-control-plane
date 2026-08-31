# Multi-Prompt Test Scenario

## Objective
Verify that the agent maintains context across multiple prompts in a single session.

## Steps
1. Start session with initial prompt: "Create a calculator class with add, subtract, multiply, divide methods"
2. Capture initial response and file creation
3. Send follow-up prompt: "Add unit tests for all methods using Vitest"
4. Verify context maintained (references Calculator class from step 1)
5. Send second follow-up: "Add error handling for division by zero"
6. Verify cumulative context (references both class and tests)
7. Stop session

## Expected Events Sequence
```
1. session.started
2. assistant.thinking
3. assistant.message (creates Calculator class)
4. tool.call (write calculator.ts)
5. tool.result
6. file.write
7. assistant.message (completion)
8. user.message (follow-up: "Add unit tests")
9. assistant.thinking
10. assistant.message (creates tests)
11. tool.call (write calculator.test.ts)
12. tool.result
13. file.write
14. assistant.message (completion)
15. user.message (follow-up: "Add error handling")
16. assistant.thinking
17. assistant.message (modifies calculator.ts)
18. tool.call (edit calculator.ts)
17. tool.result
18. file.write (with diff)
19. assistant.message (completion)
20. session.completed
```

## Success Criteria
- All three prompts processed in same session
- Follow-up prompts reference previous work (class name, method names)
- Files created/modified correctly
- No session restart between prompts
- Context window maintained across turns

## Mock Agent Configuration
```json
{
  "scenario": "multi-turn",
  "delay": 100
}
```

## OpenCode Command
```bash
# First prompt
opencode run --headless --json --prompt "Create a calculator class..." --approval-mode auto

# Follow-ups sent via stdin to running process
echo "Add unit tests for all methods using Vitest" | opencode run --headless --json --prompt -
```