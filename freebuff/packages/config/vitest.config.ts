import { defineConfig } from 'vitest/config';
import path from 'node:path';

export default defineConfig({
  test: {
    environment: 'node',
    globals: true,
    include: ['src/**/*.{test,spec}.ts'],
    coverage: {
      provider: 'v8',
      reporter: ['text', 'json', 'html'],
      include: ['src/**/*.ts'],
      exclude: ['src/**/*.test.ts', 'src/**/index.ts']
    }
  },
  resolve: {
    alias: {
      '@freebuff/protocol': path.resolve(__dirname, '../protocol/src/index.ts'),
      '@freebuff/schemas': path.resolve(__dirname, '../schemas/src/index.ts'),
      '@freebuff/config': path.resolve(__dirname, './src/index.ts')
    }
  }
});
