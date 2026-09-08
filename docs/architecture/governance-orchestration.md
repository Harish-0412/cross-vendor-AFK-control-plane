# Freebuff Architecture: Governance & Orchestration Layer

**Document:** Architecture Overview for the Governance and Orchestration Services  
**Project:** Freebuff — The Kubernetes/Control-Plane Layer for AI Coding Agents  
**Status:** Planning / Strategic Direction  

---

## 1. The Core Insight

Freebuff's differentiator is not "remote control for coding agents." It's **"the Kubernetes/control-plane layer for AI coding agents."**

The key architectural insight: **agents become interchangeable execution engines.**

When a user says "Fix this production bug," Freebuff decides:
- Which agent should handle it
- Which model/provider to use
- What permissions the agent gets
- What files it can access
- What network destinations it can reach
- What actions require approval
- How much compute/token budget it can consume
- Whether another agent should review the work
- Whether the final change satisfies organizational policy

This turns Freebuff into an **agent-neutral execution marketplace** — "Bring your own agent. We govern the work."

---

## 2. High-Level Architecture

```
                   YOUR CONTROL PLANE
                          │
        ┌─────────────────┼─────────────────┐
        │                 │                 │
      SECURITY         GOVERNANCE       INTELLIGENCE
        │                 │                 │
    Sandbox             Policy           Routing
    Firewall            Risk             Cost
    Secrets             Approval         Reputation
    DLP                 Audit            Benchmark
        │                 │                 │
        └─────────────────┼─────────────────┘
                          │
                 MULTI-AGENT FABRIC
                          │
       ┌──────────┬───────┼─────────┬──────────┐
       ▼          ▼       ▼         ▼          ▼
    Claude     Codex   OpenCode   Cursor    Internal
       │          │       │         │          │
       └──────────┴───────┴─────────┴──────────┘
                          │
                          ▼
                  SOFTWARE DELIVERY
```

### Three Zones

| Zone | Responsibility |
|---|---|
| **Security** | Sandbox, firewall, secrets, DLP — keep agents contained |
| **Governance** | Policy, risk, approval, audit — control what agents do |
| **Intelligence** | Routing, cost, reputation, memory, verification — make agents smart |

---

## 3. Service Catalog

### 3.1 Agent Router

**Problem:** Developers manually choose agents. Different agents excel at different things.

**Solution:** Automatically select the best agent(s) for each task.

**Inputs:**
- Task complexity
- Security sensitivity
- Repository size
- Required tools
- Latency requirement
- Budget
- Agent availability
- Historical success rate

**Example:**
```
Task: "Refactor authentication and add comprehensive tests"

Claude → implementation
Codex → security review
OpenCode → test generation
```

**Configuration:**
```yaml
routing:
  security_tasks:
    preferred_agent: codex

  frontend_tasks:
    preferred_agent: claude

  cheap_tasks:
    preferred_agent: opencode

  high_risk_tasks:
    strategy: multi_agent_review
```

**Data model:**
- `routing_policies`: YAML/Rego policy definitions
- `routing_decisions`: Audit log of which agent was selected for which task and why
- `agent_capabilities`: Declared capabilities per agent version

---

### 3.2 Multi-Agent Orchestrator

**Problem:** Single agents can't handle complex tasks that require specialization.

**Solution:** Coordinate specialized agents as teams.

**Pattern:**
```
User
 │
 ▼
Planner Agent
 │
 ├──► Coding Agent
 ├──► Test Agent
 ├──► Security Agent
 └──► Review Agent
            │
            ▼
        Final Gate
```

**Example: "Implement OAuth login"**
- Agent A: Architecture + implementation
- Agent B: Security review
- Agent C: Tests
- Agent D: Code review

**Aggregation:**
```
Implementation confidence: 91%
Security confidence: 96%
Test confidence: 88%

Final decision → Human approval
```

**Data model:**
- `orchestration_plans`: Task decomposition into agent assignments
- `orchestration_runs`: Execution instances with agent status tracking
- `orchestration_results`: Aggregated confidence scores and final decisions

**Safety principle:** Orchestration never becomes an uncontrolled privilege multiplier. Each spawned agent receives scoped permissions.

---

### 3.3 Risk Engine

**Problem:** Policy engines answer "Is this allowed?" but not "How dangerous is this?"

**Solution:** Score every action by danger level.

**Risk scores:**
```
git status              → 0.01
npm install             → 0.15
git push                → 0.52
rm -rf                  → 0.89
production deploy       → 0.97
```

**Uses:**
- Dynamic approval thresholds (higher risk → stricter approval)
- Cost allocation (risky tasks cost more to supervise)
- Agent selection (risky tasks → more capable agent)
- Alert prioritization (high-risk actions get immediate attention)

**Data model:**
- `risk_scoring_rules`: Configurable risk scoring based on action type, context, and patterns
- `risk_assessments`: Per-action risk scores with context

---

### 3.4 Agent Firewall

**Problem:** Agents need network access but shouldn't exfiltrate data or reach internal systems.

**Solution:** Per-session network policies with deny-by-default.

**Configuration:**
```yaml
firewall:
  default: deny-all
  allow:
    - registry.npmjs.org
    - pypi.org
    - github.com
  block:
    - internal.corp.net
    - *.prod.internal
  inspect:
    - data exfiltration patterns
    - credential transmission
```

**Implementation:**
- Network namespace isolation per session
- Egress filtering at the sandbox level
- DNS filtering
- TLS inspection where appropriate
- Data exfiltration pattern detection

**Data model:**
- `firewall_policies`: Per-project/per-session network policies
- `firewall_events`: Blocked connection attempts and inspection alerts

---

### 3.5 Cost/Token Governor

**Problem:** Different agents/models have different costs. Runaway sessions can consume large budgets.

**Solution:** Budget enforcement at every level.

**Scope:**
- Per task
- Per session
- Per agent/provider
- Per project
- Per organization
- Per time window (hourly/daily/monthly)

**Features:**
- Token/compute limits per session
- Cost anomaly detection
- Budget alerts and automatic pause
- Cost attribution to projects/teams
- Cost forecasting based on task complexity

**Data model:**
- `budgets`: Budget definitions at various scopes
- `cost_events`: Token usage, compute time, API costs per session
- `cost_alerts`: Budget threshold crossings

---

### 3.6 Agent Reputation System

**Problem:** How do you know which agent is best for which task?

**Solution:** Track and aggregate agent performance.

**Metrics:**
- Success rate per task type
- Failure modes and patterns
- Cost efficiency (outcome per dollar)
- Completion time
- Quality metrics (test coverage, lint pass rate, review findings)
- User satisfaction signals

**Uses:**
- Feeds the Agent Router
- Helps administrators make informed agent selection decisions
- Identifies agents that need review or removal

**Data model:**
- `agent_reputation`: Aggregated metrics per agent/provider/task-type
- `agent_outcomes`: Individual task outcomes for aggregation

---

### 3.7 Universal Agent Memory

**Problem:** Each agent session starts fresh. Knowledge doesn't persist across agents.

**Solution:** Shared knowledge layer.

**Contents:**
- Codebase context that any agent can access
- Learned patterns and conventions
- Previously solved problems and their solutions
- Project-specific knowledge (build commands, test patterns, deployment steps)
- Cross-agent learnings (what worked, what didn't)

**Implementation:**
- Vector store for semantic search
- Structured knowledge graph for relationships
- Event-sourced updates from agent sessions

**Data model:**
- `memory_chunks`: Atomic units of knowledge with metadata
- `memory_indexes`: Search indexes for retrieval

---

### 3.8 Automated Verification Service

**Problem:** How do you know the agent's work is correct?

**Solution:** Post-task verification.

**Checks:**
- Run test suites automatically
- Check code coverage
- Validate against task requirements
- Lint and style checks
- Security scanning
- Performance regression checks
- Cross-agent verification (another agent reviews the work)

**Data model:**
- `verification_runs`: Per-task verification executions
- `verification_results`: Pass/fail per check with details

---

### 3.9 Policy-as-Code

**Problem:** Policies are declarative configurations. Complex governance needs programmable policies.

**Solution:** Policy definitions in multiple formats.

**Formats:**
- YAML for simple rules
- Rego (Open Policy Agent) for complex logic
- WebAssembly plugins for custom policy logic

**Examples:**
```yaml
policies:
  - name: security-review-required
    condition: task.type == "security" and task.risk_score > 0.7
    action: require_multi_agent_review
    agents:
      - codex
      - claude

  - name: budget-enforcement
    condition: session.estimated_cost > project.daily_budget
    action: require_approval

  - name: protected-branches
    condition: git.push.target in protected_branches
    action: deny_without_approval
    deny_fallback: true  # cannot be overridden
```

**Data model:**
- `policies`: Policy definitions with version tracking
- `policy_evaluations`: Audit log of policy decisions

---

### 3.10 Agent Marketplace/Registry

**Problem:** Adding new agents requires manual integration work.

**Solution:** Discoverable, version-pinned agents with metadata.

**Contents:**
- Capability declarations
- Version pinning and hash verification
- Compatibility metadata
- Usage documentation
- Community ratings and reviews
- One-click adapter installation

**Data model:**
- `agents`: Agent metadata and capability declarations
- `adapter_versions`: Versioned adapter packages with hashes
- `adapter_reviews`: Community feedback

---

### 3.11 Task Scheduler

**Problem:** Tasks need to run on schedules, not just on-demand.

**Solution:** Cron-based and event-driven scheduling.

**Types:**
- Cron-based (e.g., "run tests every hour")
- Event-driven (e.g., "on push to main, run security review")
- Manual with scheduled start
- Recurring maintenance tasks

**Inheritance:** Each scheduled task inherits policies, budgets, and agent routing rules.

**Data model:**
- `schedules`: Schedule definitions
- `scheduled_runs`: Instances of scheduled task execution

---

### 3.12 Incident/Recovery Service

**Problem:** Failed tasks need recovery and analysis.

**Solution:** Checkpoint-based recovery and incident management.

**Features:**
- Checkpoint-based session recovery
- Automatic rollback on verification failure
- Incident summary generation
- Post-incident analysis
- Session replay for debugging

**Data model:**
- `checkpoints`: Session state snapshots
- `incidents`: Incident records with recovery actions
- `recovery_logs`: Step-by-step recovery execution logs

---

### 3.13 Compliance Evidence Engine

**Problem:** Audits require evidence packages. Manual compilation is slow.

**Solution:** Auto-generate evidence packages.

**Targets:**
- SOC2
- ISO27001
- Internal audits
- Security reviews

**Evidence:**
- Audit trail exports
- Policy enforcement records
- Approval logs
- Agent activity summaries
- Sandbox isolation proofs

**Data model:**
- `evidence_packages`: Compiled evidence for specific audit requests
- `evidence_templates`: Templates for standard audit types

---

### 3.14 Cross-Agent Benchmarking

**Problem:** Need objective comparison of agent performance.

**Solution:** Standardized task comparison.

**Metrics:**
- Implementation speed
- Code quality
- Test coverage achieved
- Cost efficiency
- Security findings caught

**Uses:**
- Agent selection decisions
- Capacity planning
- Cost optimization
- Vendor evaluation

**Data model:**
- `benchmark_suites`: Standardized task definitions
- `benchmark_results`: Per-agent results on benchmark tasks

---

### 3.15 Human Approval Intelligence

**Problem:** Approvals are noisy and poorly routed.

**Solution:** Smart approval management.

**Features:**
- Route approvals to the right approver based on expertise
- Batch similar approvals
- Suggest approval/denial based on policy and history
- Escalation policies for urgent items
- Approval fatigue reduction (smart notification timing)

**Data model:**
- `approval_routes`: Rules for routing approvals to approvers
- `approval_suggestions`: AI-generated suggestions for approval decisions
- `approval_batches`: Grouped approvals for efficient review

---

## 4. Integration with Core Control Plane

These governance and orchestration services build on the core control plane delivered in Phase 3:

```
┌─────────────────────────────────────────────────────────────┐
│                     GOVERNANCE & ORCHESTRATION                │
│  Agent Router │ Orchestrator │ Risk Engine │ Firewall        │
│  Cost Governor │ Reputation │ Memory │ Verification         │
│  Policy-as-Code │ Marketplace │ Scheduler │ Compliance       │
└────────────────────────────────┬────────────────────────────┘
                                 │
┌────────────────────────────────┴────────────────────────────┐
│                        CONTROL PLANE                         │
│  Auth │ Devices │ Sessions │ Tasks │ Events │ Approvals     │
│  Audit │ Notifications │ Integrations                        │
└────────────────────────────────┬────────────────────────────┘
                                 │
                 Secure outbound tunnel (WSS)
                                 │
┌────────────────────────────────┴────────────────────────────┐
│                         AGENT GATEWAY                        │
│  Gateway Core │ Adapter Manager │ Sandbox │ Policy Client   │
│  Redaction │ Checkpoints │ Tunnel Client │ Health           │
└─────────────────────────────────────────────────────────────┘
                                 │
                    ┌────────────┴────────────┐
                    ▼                         ▼
                Agents                    Sandbox
```

---

## 5. Data Flow Example: Multi-Agent Task

```
User: "Fix the authentication bug and add tests"

1. Agent Router evaluates task
   → Complexity: high
   → Security sensitivity: high
   → Recommended: Claude (implementation) + Codex (security review)

2. Orchestrator creates plan
   → Agent A (Claude): Implement fix
   → Agent B (Codex): Security review
   → Agent C (OpenCode): Write tests

3. Risk Engine scores each action
   → Agent A's file edits: 0.35
   → Agent A's git commit: 0.52
   → Agent B's review: 0.15

4. Agent Firewall applies per-agent policies
   → All agents: deny internal.corp.net
   → Agent A: allow github.com (dependency fetch)
   → Agent B: allow pkg.go.dev (security database)

5. Cost Governor sets budgets
   → Agent A: $0.50 max
   → Agent B: $0.20 max
   → Agent C: $0.10 max

6. Agents execute in parallel
   → Events stream to control plane
   → Universal Memory captures learnings

7. Verification Service runs
   → Tests pass: ✓
   → Coverage: 85% ✓
   → Security review: no findings ✓
   → Overall confidence: 92%

8. Human Approval Intelligence presents summary
   → "Implementation confidence: 91%, Security: 96%, Tests: 88%"
   → Suggests approval

9. User approves (or requests changes)

10. Compliance Evidence Engine logs everything for audit
```

---

## 6. Competitive Positioning

| Competitor | Approach | Freebuff Difference |
|---|---|---|
| OpenAI Codex | "Our agent with our governance" | "Any agent with your governance" |
| Coder | Centralized agent controls | Vendor-neutral, multi-agent orchestration |
| GitHub Copilot | Async coding agents with review | Unified layer for ALL agents |
| Cloudflare AI Gateway | Observability + DLP for coding agents | Full governance + orchestration + routing |
| Devin | Enterprise RBAC + audit for their agent | Neutral layer for any agent |

**The strategic gap:** Everyone builds governance for *their* agent. Freebuff builds governance for *any* agent.

---

## 7. Implementation Priority

After core control plane stabilization:

1. **Agent Router** — highest strategic value, immediate differentiation
2. **Multi-Agent Orchestration** — killer feature potential
3. **Risk Engine** — enhances existing policy engine
4. **Agent Firewall** — security differentiator
5. **Cost/Token Governor** — enterprise requirement
6. **Agent Reputation System** — feeds router
7. **Universal Agent Memory** — enables better agent performance
8. **Automated Verification Service** — quality assurance
9. **Policy-as-Code** — enterprise flexibility
10. **Agent Marketplace/Registry** — ecosystem play

---

## 8. Open Questions

- How much agent routing should be automatic vs. user-overridable?
- What's the minimum viable multi-agent orchestration (two agents? three?)
- How do we handle agent-to-agent communication vs. all-through-control-plane?
- What benchmarking tasks are representative enough to be useful?
- How do we prevent orchestration from becoming a privilege multiplier?
- What's the right balance between policy-as-code flexibility and safety?
