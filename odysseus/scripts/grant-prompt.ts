/**
 * The approval screen, shared by `pnpm grants approve` and the prompt the
 * running gateway shows when a request arrives.
 *
 * Everything the owner needs to decide is on screen before they type anything:
 * who asked, what each scope reads, the exact folders and how many files are
 * in them, what leaves the machine, and what is never read.
 */
import { createInterface } from 'node:readline/promises';

import { DeviceIdentityManager } from '../gateway/identity/src/device-identity';
import {
  IntegrationManager,
  defaultPathContext,
  displayPath,
  integrationRoots,
  previewIntegration,
  type DeviceSigner,
  type PendingRequest,
} from '../gateway/integrations/src/index';
import { INTEGRATIONS, type IntegrationUpdate } from '../packages/protocol/src/index';

import { bold, card, dim, formatRemaining, paint, palette, write } from './pair-ui';

export function signerFor(identityManager: DeviceIdentityManager): DeviceSigner {
  const identity = identityManager.getIdentity();
  return {
    deviceId: identity.deviceId,
    sign: (data) => identityManager.sign(data),
    verify: (data, signature) => identityManager.verifySignature(data, signature),
  };
}

/** A manager bound to this machine's device key. */
export async function openManager(
  onUpdate?: (update: IntegrationUpdate) => void,
): Promise<IntegrationManager> {
  const identityManager = new DeviceIdentityManager();
  await identityManager.initialize();
  return new IntegrationManager({
    signer: signerFor(identityManager),
    ctx: defaultPathContext(),
    ...(onUpdate ? { onUpdate } : {}),
  });
}

export async function renderRequest(request: PendingRequest): Promise<void> {
  const definition = INTEGRATIONS[request.integration];
  const ctx = defaultPathContext();
  const preview = await previewIntegration(
    request.integration,
    request.scopes,
    integrationRoots(request.integration, ctx),
  );

  const lines: string[] = [
    `${dim('requested by')}  ${bold(request.requestedBy.email ?? request.requestedBy.userId)}`,
    `${dim('expires in  ')}  ${formatRemaining(Date.parse(request.expiresAt) - Date.now())}`,
    '',
    bold('It will be allowed to:'),
  ];
  for (const scope of request.scopes) {
    lines.push(`  ${paint(palette.amber, '•')} ${scope.padEnd(12)} ${definition.reads[scope] ?? ''}`);
  }

  if (preview.length > 0) {
    lines.push('', bold('Folders on this machine:'));
    for (const folder of preview) {
      const where = displayPath(folder.root, ctx);
      lines.push(
        folder.exists
          ? `  ${paint(palette.cream, where)}  ${dim(`${folder.matchingFiles} matching files`)}`
          : `  ${paint(palette.slate, where)}  ${dim('not present on this machine')}`,
      );
    }
  }

  lines.push('', bold('What leaves this machine:'), `  ${definition.leavesMachine}`);
  lines.push('', bold('Never read:'));
  for (const item of definition.neverRead) lines.push(`  ${paint(palette.green, '✓')} ${item}`);

  write();
  card(`ACCESS REQUEST · ${definition.name.toUpperCase()}`, lines, palette.violet);
  write();
}

export type PromptOutcome = 'approved' | 'denied' | 'skipped';

/**
 * Ask for the confirmation code. Typing `deny` refuses the request; an empty
 * line leaves it pending (it can still be approved with `pnpm grants`).
 */
export async function promptForApproval(
  manager: IntegrationManager,
  request: PendingRequest,
): Promise<PromptOutcome> {
  const interactive = Boolean(process.stdin.isTTY);
  if (!interactive) {
    write(dim('  Not an interactive terminal — approve it with `pnpm grants approve` in a terminal.'));
    return 'skipped';
  }

  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    for (;;) {
      const answer = (
        await rl.question(
          `  ${bold('Type the code shown in your browser')} ${dim('(or "deny", or Enter to decide later)')}: `,
        )
      ).trim();

      if (!answer) {
        write(dim('  Left pending. Approve later with `pnpm grants approve`.'));
        return 'skipped';
      }
      if (answer.toLowerCase() === 'deny') {
        await manager.deny(request.requestId);
        write(`  ${paint(palette.red, '✗')}  Denied`);
        return 'denied';
      }

      const result = await manager.approve(request.requestId, answer, { interactive });
      if (result.ok) {
        write(`  ${paint(palette.green, '✓')}  ${bold('Access granted')} ${dim(`until ${result.state.expiresAt?.slice(0, 10)}`)}`);
        return 'approved';
      }
      write(`  ${paint(palette.red, '✗')}  ${result.reason}`);
      if (result.attemptsLeft === undefined) return 'denied';
      write(dim(`     ${result.attemptsLeft} attempts left`));
    }
  } finally {
    rl.close();
  }
}
