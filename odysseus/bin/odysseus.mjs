#!/usr/bin/env node

import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const packageRoot = join(dirname(fileURLToPath(import.meta.url)), '..');
const commands = Object.freeze({
  gateway: 'gateway.mjs',
  pair: 'pair.mjs',
  grants: 'grants.mjs',
  import: 'import.mjs',
  'openai-org': 'openai-org.mjs',
});

const usage = `Odysseus Gateway

Usage:
  odysseus pair
  odysseus gateway --project-root <path>
  odysseus grants <command>
  odysseus import <provider> <file>
  odysseus openai-org <command>

Commands:
  pair          Pair this computer with the hosted Odysseus Control Plane
  gateway       Start the secure local gateway
  grants        Approve, inspect, revoke, or terminate local access grants
  import        Import supported conversation exports locally
  openai-org    Configure or sync OpenAI organization usage

Environment:
  CONTROL_PLANE_URL              HTTPS URL used by the pairing command
  ODYSSEUS_WEB_URL               Optional web application URL override
  ODYSSEUS_CONTROL_PLANE_URL     WSS tunnel URL used by the gateway

Run "odysseus <command> --help" for command-specific options.`;

async function version() {
  const raw = await readFile(join(packageRoot, 'package.json'), 'utf8');
  return JSON.parse(raw).version;
}

const argv = process.argv.slice(2);
if (argv.length === 0 || argv[0] === 'help' || argv[0] === '--help' || argv[0] === '-h') {
  console.log(usage);
  process.exit(0);
}
if (argv[0] === '--version' || argv[0] === '-v') {
  console.log(await version());
  process.exit(0);
}

const command = argv.shift();
const scriptName = commands[command];
if (!scriptName) {
  console.error(`Unknown command: ${command}\n\n${usage}`);
  process.exit(64);
}

// The source commands default to localhost for monorepo development. The
// installed CLI is the hosted-product entrypoint, so give it production
// defaults without overriding an explicit self-hosted configuration.
process.env.ODYSSEUS_CLI_COMMAND ??= 'odysseus';
if (command === 'pair') {
  process.env.CONTROL_PLANE_URL ??= 'https://odysseus-control-plane.onrender.com';
}
if (command === 'gateway') {
  process.env.ODYSSEUS_CONTROL_PLANE_URL ??= 'wss://odysseus-control-plane.onrender.com/ws/tunnel';
}

const script = join(packageRoot, 'dist-package', scriptName);
process.argv = [process.execPath, script, ...argv];
await import(pathToFileURL(script).href);
