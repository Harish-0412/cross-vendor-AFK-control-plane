# OpenCode Phase 8.4 findings

**Observed binary:** `opencode` 1.18.23 on 2026-09-08.

The installed CLI's `opencode run --help` exposes `--auto`, described as
auto-approving permissions that are not explicitly denied. It does not expose
an external approval callback, a confirmation socket, or a stdin protocol for
submitting an approval decision to an already-running `run` process. Its JSON
mode is an output stream, not a bidirectional policy protocol.

Therefore the OpenCode adapter declares:

```ts
approvalInterception: 'unsupported'
```

`requestApproval()` and `submitApprovalDecision()` fail explicitly. They never
pretend to pause a tool action, and the adapter integration test proves native
output continues rather than being buffered behind a fictional approval gate.
This means Phase 5 can enforce pre-execution session policy for this adapter,
but cannot guarantee mid-execution interception of a HIGH or CRITICAL OpenCode
tool action.

The same test initializes a real temporary Git repository, changes a tracked
file, and verifies `collectDiff()` returns the actual unified diff. The adapter
uses a non-shell `git diff --no-ext-diff --binary --` invocation with a five
second timeout, matching the safe execution pattern in Gateway ProjectManager.
