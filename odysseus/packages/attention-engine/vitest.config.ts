import { defineConfig } from 'vitest/config';
import { sharedTestConfig, workspaceAliases } from '../../vitest.shared';

export default defineConfig({
  resolve: { alias: workspaceAliases },
  test: sharedTestConfig,
});
