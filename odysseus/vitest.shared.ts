import path from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Single source of truth for how tests resolve workspace packages.
 *
 * Builds resolve `@odysseus/*` through each package's `exports`/`types` field
 * to its built `dist`. Tests deliberately do not: they alias straight to
 * TypeScript source so the suite runs on a clean checkout with no build step,
 * and so a failure points at a source line rather than a compiled artifact.
 *
 * Every package's vitest.config.ts pulls its aliases from here — previously
 * three packages each resolved workspace imports a different way, which let
 * them drift apart silently.
 */
const workspaceRoot = path.dirname(fileURLToPath(import.meta.url));

const packageSources: Record<string, string> = {
  '@odysseus/protocol': 'packages/protocol/src/index.ts',
  '@odysseus/schemas': 'packages/schemas/src/index.ts',
  '@odysseus/config': 'packages/config/src/index.ts',
  '@odysseus/mock-adapter': 'gateway/adapters/mock/src/index.ts',
  '@odysseus/opencode-adapter': 'gateway/adapters/opencode/src/index.ts',
  '@odysseus/antigravity-adapter': 'gateway/adapters/antigravity/src/index.ts',
  '@odysseus/checkpoint': 'gateway/checkpoint/src/index.ts',
  '@odysseus/health': 'gateway/health/src/index.ts',
  '@odysseus/sandbox': 'gateway/sandbox/src/index.ts',
  '@odysseus/tunnel': 'gateway/tunnel/src/index.ts',
  '@odysseus/identity': 'gateway/identity/src/index.ts',
  '@odysseus/pairing': 'gateway/pairing/src/index.ts',
  '@odysseus/certificate': 'gateway/certificate/src/index.ts',
  '@odysseus/reconciliation': 'gateway/reconciliation/src/index.ts',
  '@odysseus/gateway-core': 'gateway/core/src/index.ts',
  '@odysseus/control-plane': 'control-plane/src/index.ts',
  '@odysseus/policy-engine': 'packages/policy-engine/src/index.ts',
  '@odysseus/attention-engine': 'packages/attention-engine/src/index.ts',
  '@odysseus/gateway-policy': 'gateway/policy/src/index.ts',
  '@odysseus/redaction': 'gateway/redaction/src/index.ts',
  '@odysseus/integrations': 'gateway/integrations/src/index.ts',
};

export const workspaceAliases: Record<string, string> = Object.fromEntries(
  Object.entries(packageSources).map(([name, relativePath]) => [
    name,
    path.join(workspaceRoot, relativePath).replace(/\\/g, '/'),
  ]),
);

/** Shared `test` block. Packages spread this and override only what differs. */
export const sharedTestConfig = {
  environment: 'node' as const,
  globals: true,
  include: ['src/**/*.{test,spec}.ts', 'tests/**/*.{test,spec}.ts'],
  coverage: {
    provider: 'v8' as const,
    reporter: ['text', 'json', 'html'],
    include: ['src/**/*.ts'],
    exclude: ['src/**/*.test.ts', 'src/**/*.spec.ts', 'src/**/index.ts'],
  },
  testTimeout: 30_000,
  hookTimeout: 30_000,
};
