# Adapter 2 decision: Antigravity CLI

**Decision date:** 2026-09-08  
**Chosen adapter:** Antigravity CLI (`agy`)

Antigravity is the second Phase 8 adapter. The choice is a re-validation of the
criteria in [the compatibility matrix](compatibility-matrix.md), not a
re-ranking based on vendor preference.

| Criterion | Finding | Decision impact |
| --- | --- | --- |
| Local execution | The CLI runs locally and uses cached credentials for headless runs. | Meets the local-first boundary. |
| JSON event streaming | `--output-format stream-json` emits NDJSON `init`, `step_update`, and `result` records. | Supports a deterministic parser and real-time Gateway event flow. |
| Session/prompt continuity | `--input-format stream-json` accepts multiple prompt records on one open stdin stream. | Supports the multi-turn adapter contract without synthesizing a session layer. |
| Approvals and sandboxing | The CLI exposes permission modes and a sandbox option; the current docs describe the default as request-review. | Stronger policy-integration candidate than a CLI with only a one-shot run mode. |
| Operational constraints | Authentication must be completed interactively first; local model/provider availability remains an environment requirement. | Record these as environment validation checks rather than silently falling back. |

OpenCode remains Adapter 1 because it is open source, locally executable, and
offers `run --format json`, session export/import, and a headless server.
Antigravity is selected for Adapter 2 because current official documentation
now confirms both bidirectional streaming and persistent stdin-driven sessions,
which make it a meaningfully independent test of the same Freebuff contract.

Sources checked on 2026-09-08:

- [OpenCode CLI reference](https://dev.opencode.ai/docs/cli) (`run --format json`, `serve`, session operations).
- [Google Antigravity headless-mode reference](https://www.antigravity.google/docs/cli/headless/) (NDJSON streaming, stdin-driven multi-turn sessions, permissions, and sandbox option).
- [Claude Code CLI reference](https://docs.anthropic.com/en/docs/claude-code/cli-usage) (streaming capability confirmed, but proprietary/paid dependency remains less aligned with the project’s local-first/open-source weighting).
