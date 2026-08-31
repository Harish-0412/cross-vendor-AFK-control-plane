# Agent Compatibility Matrix

## Executive Summary

This matrix compares candidate AI coding agents for integration with Freebuff's Local Agent Gateway. The evaluation criteria align with Freebuff's core architectural requirements: **local execution**, **sandboxing**, **durable sessions**, **programmable approvals**, **event streaming**, and **vendor neutrality**.

| Rank | Agent | Overall Fit | Phase Target | Key Strength | Key Gap |
|------|-------|-------------|--------------|--------------|---------|
| 1 | **Mock Agent** | ✅ Perfect | Phase 0-1 | Deterministic, no deps, full control | Not a real agent |
| 2 | **Antigravity** | ✅ Excellent | Phase 8 | Local-first, built-in sandbox, webhook approvals, daemon mode | Requires local LLM hardware |
| 3 | **OpenCode** | ✅ Good | Phase 8 | Open source, released, good JSON CLI | No daemon, manual session persistence |
| 4 | **Claude Code** | ⚠️ Acceptable | Phase 9+ | Local execution, good model quality | Proprietary, paid API, preview |
| 5 | **Codex** | ❌ Poor | Optional | Cloud sync, enterprise features | Cloud-only, violates local-first |

---

## Detailed Capability Comparison

### Core Architecture Alignment

| Capability | Mock Agent | Antigravity | OpenCode | Claude Code | Codex |
|------------|------------|-------------|----------|-------------|-------|
| **Local Execution** | ✅ N/A | ✅ Native | ✅ Native | ✅ Native | ❌ Cloud-only |
| **Offline Capable** | ✅ N/A | ✅ Full | ❌ Needs API | ❌ Needs API | ❌ No |
| **Air-Gapped** | ✅ N/A | ✅ Yes | ❌ No | ❌ No | ❌ No |
| **Sandboxing** | ✅ Simulated | ✅ Built-in profiles | ❌ External | ❌ External | ❌ None |
| **Daemon/Server Mode** | ✅ Simulated | ✅ Native | ❌ No | ❌ No | ❌ No |
| **Process Isolation** | ✅ Simulated | ✅ Configurable | ❌ External | ❌ External | ❌ N/A |

### Session Management

| Capability | Mock Agent | Antigravity | OpenCode | Claude Code | Codex |
|------------|------------|-------------|----------|-------------|-------|
| **Persistent Sessions** | ✅ In-memory | ✅ SQLite + checkpoints | ⚠️ Manual export/import | ✅ Local files | ✅ Cloud |
| **Checkpoint/Resume** | ✅ Full | ✅ Per-turn + snapshots | ⚠️ Manual | ✅ Auto-save | ✅ Cloud |
| **Session Fork/Branch** | ✅ Full | ✅ Native | ❌ No | ❌ No | ❌ No |
| **Session Export/Import** | ✅ Full | ✅ JSON/MsgPack | ✅ JSON | ✅ JSON | ✅ Cloud |
| **Concurrent Sessions** | ✅ Full | ✅ Daemon: 10+ | ✅ Process per session | ✅ Multiple | ✅ Cloud |
| **Session Query/History** | ✅ Full | ✅ SQLite queryable | ❌ File-based | ❌ File-based | ✅ Cloud API |

### Event Streaming & Protocol

| Capability | Mock Agent | Antigravity | OpenCode | Claude Code | Codex |
|------------|------------|-------------|----------|-------------|-------|
| **JSON Lines Output** | ✅ | ✅ | ✅ | ✅ Expected | ✅ Expected |
| **MessagePack Binary** | ✅ | ✅ | ❌ | ❌ | ❌ |
| **WebSocket/SSE** | ✅ | ✅ Daemon mode | ❌ | ❌ | ⚠️ Possible |
| **Unix Domain Socket** | ✅ | ✅ Daemon mode | ❌ | ❌ | ❌ |
| **Structured Event Envelope** | ✅ Freebuff native | ✅ Compatible | ⚠️ Adapter transforms | ⚠️ Adapter transforms | ⚠️ Adapter transforms |
| **Sequence Numbers** | ✅ | ✅ | ❌ | ❌ | ❌ |
| **Correlation IDs** | ✅ | ✅ | ❌ | ❌ | ❌ |

### Approval & Policy Integration

| Capability | Mock Agent | Antigravity | OpenCode | Claude Code | Codex |
|------------|------------|-------------|----------|-------------|-------|
| **Programmable Approvals** | ✅ Full control | ✅ Webhook callback | ❌ Modes only | ❌ Config rules | ❌ Cloud policy |
| **Risk-Based Rules** | ✅ Full control | ✅ Declarative | ❌ No | ⚠️ Config only | ⚠️ Cloud dashboard |
| **External Policy Engine** | ✅ Native | ✅ Webhook | ❌ No | ❌ No | ❌ No |
| **Approval Timeout** | ✅ Configurable | ✅ Configurable | ❌ No | ❌ No | ❌ No |
| **Fallback Behavior** | ✅ Configurable | ✅ Configurable | ❌ No | ❌ No | ❌ No |
| **Audit Trail** | ✅ Full | ✅ Built-in | ⚠️ Event log | ⚠️ Event log | ✅ Cloud |

### Sandbox & Security

| Capability | Mock Agent | Antigravity | OpenCode | Claude Code | Codex |
|------------|------------|-------------|----------|-------------|-------|
| **Filesystem Restrictions** | ✅ Simulated | ✅ Path allow/deny | ❌ External | ❌ External | ❌ None |
| **Process Allow/Deny Lists** | ✅ Simulated | ✅ Configurable | ❌ External | ❌ External | ❌ None |
| **Network Deny-by-Default** | ✅ Simulated | ✅ Native | ❌ External | ❌ External | ❌ None |
| **Resource Limits (CPU/Mem)** | ✅ Simulated | ✅ Configurable | ❌ External | ❌ External | ❌ None |
| **Secret Redaction** | ✅ Simulated | ⚠️ External | ❌ External | ❌ External | ❌ None |
| **Secret Path Blocking** | ✅ Simulated | ✅ Configurable | ❌ External | ❌ External | ❌ None |

### Operational Characteristics

| Capability | Mock Agent | Antigravity | OpenCode | Claude Code | Codex |
|------------|------------|-------------|----------|-------------|-------|
| **License** | MIT (internal) | Apache 2.0 | MIT | Proprietary | Proprietary |
| **Cost** | $0 | $0 (local models) | $0 (BYOK) | Paid API | Paid API |
| **Installation** | Built-in | Binary/Docker | Binary/npm | Binary (preview) | Binary (beta) |
| **Cross-Platform** | ✅ All | ✅ Win/Mac/Linux | ✅ Win/Mac/Linux | ✅ Win/Mac/Linux | ✅ Win/Mac/Linux |
| **Maturity** | N/A | Released v1.5+ | Released v0.15+ | Preview/Beta | Beta/Preview |
| **Community** | N/A | Growing | Active | Growing | Large (OpenAI) |
| **Documentation** | Internal | Good | Good | Limited (preview) | Limited (beta) |

### Integration Effort Estimate

| Effort Category | Mock Agent | Antigravity | OpenCode | Claude Code | Codex |
|-----------------|------------|-------------|----------|-------------|-------|
| **Adapter Boilerplate** | 1 day | 3 days | 5 days | 5 days | 7 days |
| **Event Normalization** | 0 days | 1 day | 3 days | 3 days | 4 days |
| **Session Management** | 1 day | 2 days | 5 days | 3 days | 2 days |
| **Approval Integration** | 1 day | 2 days (webhook) | 2 days (modes) | 2 days (config) | 5 days (cloud) |
| **Sandbox Integration** | 1 day | 1 day (native) | 5 days (external) | 5 days (external) | N/A |
| **Testing/Validation** | 2 days | 3 days | 5 days | 5 days | 5 days |
| **Total Estimate** | **6 days** | **12 days** | **25 days** | **23 days** | **28 days** |

---

## Phase-by-Phase Recommendations

### Phase 0-1: Foundation (Mock Agent Only)
```
✅ Mock Agent Adapter
   - Deterministic event generation
   - Simulated approvals, sandbox, tools
   - No external dependencies
   - Validates Gateway core, adapter contract, sandbox manager
```

### Phase 8: First Production Adapters (Parallel Development)
```
🥇 Primary: OpenCode Adapter
   - Reason: Released, MIT licensed, good JSON CLI, active community
   - Effort: ~3-4 weeks
   - Risk: Low (stable CLI, known interface)

🥈 Secondary: Antigravity Adapter  
   - Reason: Best architectural fit, daemon mode, webhook approvals
   - Effort: ~2-3 weeks (simpler due to native features)
   - Risk: Medium (newer, hardware requirements for users)
```

### Phase 9+: Additional Adapters
```
🥉 Tertiary: Claude Code Adapter
   - When: GA release, stable CLI
   - Effort: ~3-4 weeks
   - Blockers: Proprietary, paid API, preview status

☁️ Optional: Codex Cloud Adapter
   - When: User demand for cloud fallback
   - Effort: ~4-5 weeks
   - Architecture: Separate "cloud mode" (not local gateway)
   - Warning: Document architecture mismatch clearly
```

---

## Risk Assessment

### High Risk (Blockers)
| Agent | Risk | Mitigation |
|-------|------|------------|
| Codex | Cloud-only execution | Defer; build as separate cloud mode post-MVP |
| All | API rate limits during AFK | Implement token budgets, queue management |
| All | Model quality variance | Document expected capabilities per model |

### Medium Risk (Manageable)
| Agent | Risk | Mitigation |
|-------|------|------------|
| Antigravity | User hardware requirements | Document minimum specs; provide cloud GPU option |
| OpenCode | No daemon mode | Implement session persistence in adapter |
| Claude Code | Preview API changes | Pin adapter to specific CLI version |

### Low Risk (Monitor)
| Agent | Risk | Mitigation |
|-------|------|------------|
| All | Breaking CLI changes | Version pinning, compatibility testing in CI |
| Antigravity | Smaller ecosystem | Contribute upstream; maintain fork if needed |

---

## Decision Matrix: Adapter Implementation Order

### Criteria Weights (Freebuff Priorities)
| Criterion | Weight | Rationale |
|-----------|--------|-----------|
| Local Execution | 25% | Core architecture requirement |
| Sandbox/Policy Integration | 20% | Security boundary |
| Session Durability | 15% | AFK reliability |
| Approval Programmability | 15% | Policy engine integration |
| License/Cost | 10% | Free/open-source mandate |
| Maturity/Stability | 10% | Production readiness |
| Integration Effort | 5% | Engineering velocity |

### Weighted Scores (1-5 scale)

| Agent | Local Exec (25%) | Sandbox (20%) | Session (15%) | Approvals (15%) | License (10%) | Maturity (10%) | Effort (5%) | **Total** |
|-------|------------------|---------------|---------------|-----------------|---------------|----------------|-------------|-----------|
| Mock Agent | 5 | 5 | 5 | 5 | 5 | 5 | 5 | **5.00** |
| Antigravity | 5 | 5 | 5 | 5 | 5 | 4 | 4 | **4.80** |
| OpenCode | 5 | 2 | 3 | 2 | 5 | 5 | 3 | **3.70** |
| Claude Code | 5 | 2 | 4 | 3 | 2 | 3 | 3 | **3.55** |
| Codex | 1 | 1 | 5 | 1 | 1 | 3 | 2 | **1.85** |

---

## Technical Spike Validation Plan

### Phase 0 Spikes (All Agents)
For each candidate agent, validate:

1. **Detection**: Can we programmatically detect installation?
2. **Headless Start**: `agent run --headless --json --prompt "test"`
3. **Event Parsing**: Parse JSON lines into Freebuff event envelope
4. **Prompt/Response**: Send follow-up, verify context maintained
5. **Cancellation**: SIGINT handling, cleanup verification
6. **Session Persistence**: Stop/resume, verify state recovery
7. **Approval Flow**: Trigger approval, test modes (auto/ask/never)
8. **Diff Collection**: Get diff output from file operations
9. **Sandbox Test**: Attempt filesystem escape, verify blocked
10. **Resource Limits**: CPU/memory constraints enforcement

### Spike Success Criteria
| Agent | Must Pass | Should Pass | Nice to Have |
|-------|-----------|-------------|--------------|
| Mock Agent | All 10 | N/A | N/A |
| Antigravity | 1-8, 10 | 9 | Daemon mode, webhook |
| OpenCode | 1-7, 9 | 8, 10 | Session export/import |
| Claude Code | 1-7 | 8, 9, 10 | Webhook approvals |
| Codex | 1-3, 5 | 4, 6-8 | Cloud session sync |

---

## Final Recommendations

### Immediate Actions (Week 1-2)
1. **Build Mock Agent Adapter** - Complete Phase 0.2 harness with mock
2. **OpenCode Spike** - Validate headless JSON CLI, event parsing
3. **Antigravity Spike** - Test daemon mode, webhook approvals, sandbox profiles
4. **Document Findings** - Update this matrix with empirical results

### Phase 1 Gateway Development
- Design adapter contract around **Antigravity's capabilities** (superset)
- Implement sandbox manager with **Antigravity profiles as reference**
- Build checkpoint store compatible with **SQLite + periodic snapshots**

### Phase 8 Adapter Implementation
```
Sprint 1-2: OpenCode Adapter (released, known quantity)
Sprint 3-4: Antigravity Adapter (better architecture, daemon mode)
Sprint 5:   Integration testing, comparison, documentation
```

### Long-Term Strategy
- **Maintain 2-3 production adapters** for vendor neutrality
- **Prioritize local-first agents** (Antigravity, OpenCode, future local LLMs)
- **Cloud agents as optional fallback** with clear architecture boundary
- **Contribute upstream** to improve agent APIs for control plane integration

---

## Appendix: Agent-Specific Notes

### OpenCode Integration Notes
```typescript
// Adapter will need to handle:
// - Process per session (no daemon)
// - Manual session file management for resume
// - Approval via --approval-mode flag only
// - Event parsing from JSON lines stdout
// - Sandbox via external OS/container tools
```

### Antigravity Integration Notes
```typescript
// Adapter can leverage:
// - Daemon mode for persistent AFK sessions
// - Webhook approvals for Policy Engine integration
// - Native sandbox profiles (strict/standard/permissive)
// - SQLite event log for durable history
// - Session fork for experimental branches
// - MessagePack for high-throughput event streaming
```

### Claude Code Integration Notes (Future)
```typescript
// Adapter considerations:
// - Wait for GA release and stable CLI
// - API key management (secure storage)
// - Rate limit handling for long AFK sessions
// - Approval via config file rules
// - Monitor for webhook approval support in future releases
```

---

*Last Updated: 2026-08-31*
*Next Review: After Phase 0 spike completion*