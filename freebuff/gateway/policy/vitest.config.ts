import { defineConfig } from 'vitest/config';
import { workspaceAliases, sharedTestConfig } from '../../vitest.shared';

export default defineConfig({
  test: { ...sharedTestConfig, timeout: 10_000 },
  resolve: { alias: workspaceAliases },
});
