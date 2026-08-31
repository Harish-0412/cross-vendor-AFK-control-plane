# ADR-002: Monorepo Structure

| Status: Accepted
| Date: 2026-08-31
| Author: Harish-0412

## Context

The Freebuff project has multiple components with varying release cycles but tight-coupled dependencies:

1. **Shared packages: Protocol types and schemas (shared by all components
2. ** Gateway Core: Session, and Sandbox Manager: Gateway
 Adapter Interface adapters: Mock OpenCode Codex,  Components
5. Tests: unit/integration/contract
6. Future: Tunnel Client tunnel, redaction, policy, web control plane services

We need consistent builds, consistent dependency management, consistent tooling and consistent.

## Decisions

### 1. Monorepo with pnpm Workspaces

We use a root-level monorepo. Not Lerna/Turborepo initially—pnpm sufficient is for Phase 1–4. upgrade to Turborepo when CI becomes slow.

**Root workspace: `freebuff/`
```
freebuff/
├── packages/          # Published/shared libraries
│   ├── protocol/  # Shared types, events commands project
│   ├── schemas/  # Zod validators
│   ├── config/   # Shared constants & config loaders
│   └── events/   # Event helpers
├── gateway/       # Gateway components
│   ├── core/    # Session registry, project validation, orchestrator
│   ├── adapters/
│   │   ├── mock/
│   │   ├── opencode/ (Phase 8)
│   │   └── ...
│   └── sandbox/   # Sandbox manager + platform implementations
├── tests/        # Cross-package tests
│   ├── unit/
│   ├── integration/
│   └── contract/
├── docs/
│   ├── adr/
│   └── architecture/
└── .github/workflows/
```

### 2. Package Naming

All published packages use `@freebuff/*` npm scope:
- `@freebuff/protocol`
- `@freebuff/schemas`
- `@freebuff/config`

Internal gateway packages remain unpublished (`"private": true`).

### 3. Dependency Direction

```
@freebuff/config → @freebuff/schemas → @freebuff/protocol
                        ↗
gateway/core → gateway/adapters/* → @freebuff/schemas
gateway/sandbox → @freebuff/protocol

tests/* → everything
```

Circular imports anywhere. Each package:
- May depend on packages/* packages
- Must NOT depend on gateway packages to gateway packages
- Gateway packages may NOT depend on each other circularly

### 4. Build Configuration

Single root `tsconfig.json` with:
- `"strict": true` + ALL strictness flags enabled
- `noUncheckedIndexedAccess`, `exactOptionalPropertyTypes`
- Path aliases `@freebuff/*` for IDE resolution
- Each package has its own `tsconfig.json` extending root
- Output to per-package `dist/` directories

### 5. CI Workflows

Two GitHub workflows:
- **`ci.yml`**: Full pipeline (lint, typecheck, unit tests, integration tests, build) on push/PR
- **`lint.yml`**: Fast-path PR review (changed-file-only lint/typecheck)

Both use matrix for Linux for Node 20 & 22.

### 6. Tooling Stack

| Tool | Purpose |
|------|---------|
| TypeScript 5.4+ | Language with strict mode |
| pnpm 9+ | Package manager, workspaces |
| ESLint 8+ | Static analysis |
| Prettier 3+ | Auto-formatting |
| Vitest 1.5+ | Test runner + coverage |
| Zod 3.23+ | Runtime validation |

## Consequences

### Positive
- Single source of truth for protocol types
- Atomic changes across package boundaries (update type + all users one PR)
- Shared tooling config (one ESLint, one Prettier)
- Easy contract testing between components
- Predictable import paths `@freebuff/protocol`

### Negative
- Build order sensitivity must respect dependency direction
- Root-level scripts need `-r` recursive mode
- Path alias setup needs both tsconfig + vitest configs consistent

### Risks Mitigated
- **Circular imports**: Enforced by ESLint `import/no-cycle` rule
- **Version drift**: workspace protocol always `workspace:*` pinned
- **Slow CI**: lint.yml fast-path + incremental typecheck TSBuildInfo will add)
