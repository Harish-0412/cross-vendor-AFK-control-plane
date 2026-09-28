import { cp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { build } from 'esbuild';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const output = join(root, 'dist-package');

const commandEntries = {
  gateway: join(root, 'scripts', 'start-gateway.ts'),
  pair: join(root, 'scripts', 'pair.ts'),
  grants: join(root, 'scripts', 'grants.ts'),
  import: join(root, 'scripts', 'import.ts'),
  'openai-org': join(root, 'scripts', 'openai-org.ts'),
  service: join(root, 'scripts', 'service.ts'),
};

const adapterIds = [
  'antigravity',
  'claude',
  'codex',
  'freebuff',
  'mock',
  'opencode',
  // Agent Client Protocol presets; their manifests point at gateway/adapters/acp.
  'claude-acp',
  'codex-acp',
  'gemini-acp',
  'opencode-acp',
];

await rm(output, { recursive: true, force: true });
await mkdir(output, { recursive: true });

const common = {
  bundle: true,
  format: 'esm',
  platform: 'node',
  target: 'node20',
  // ws and yaml are CommonJS and intentionally perform dynamic requires, and
  // node-pty loads a per-platform native binary. Leaving these runtime
  // dependencies external preserves their Node behavior; every Odysseus
  // workspace module is still bundled.
  external: ['ws', 'yaml', '@lydell/node-pty'],
  minify: true,
  legalComments: 'none',
  sourcemap: false,
  logLevel: 'info',
};

await build({
  ...common,
  entryPoints: commandEntries,
  outdir: output,
  outExtension: { '.js': '.mjs' },
});

for (const id of adapterIds) {
  const sourceDirectory = join(root, 'gateway', 'adapters', id);
  const targetDirectory = join(output, 'adapters', id);
  await mkdir(targetDirectory, { recursive: true });
  const manifest = JSON.parse(
    await readFile(join(sourceDirectory, 'odysseus-adapter.json'), 'utf8'),
  );
  // Bundle what the manifest names: a preset may share another package's code.
  await build({
    ...common,
    entryPoints: [join(sourceDirectory, manifest.entry)],
    outfile: join(targetDirectory, 'index.mjs'),
  });
  manifest.entry = './index.mjs';
  await writeFile(
    join(targetDirectory, 'odysseus-adapter.json'),
    `${JSON.stringify(manifest, null, 2)}\n`,
    'utf8',
  );
}

// Keep the directory self-describing for users inspecting a release asset.
await cp(join(root, 'README.md'), join(output, 'README.md'));
