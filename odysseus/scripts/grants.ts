/**
 * `pnpm grants` — see and decide integration access on this machine.
 *
 *   pnpm grants                    list integrations and pending requests
 *   pnpm grants approve [request]  approve a request (needs the browser's code)
 *   pnpm grants deny [request]     deny a request
 *   pnpm grants revoke <integration>
 *
 * Approval only works from an interactive terminal. The running gateway notices
 * any change made here and reports it to the Control Plane.
 */
import { INTEGRATIONS, isIntegrationId } from '../packages/protocol/src/index';

import { openManager, promptForApproval, renderRequest } from './grant-prompt';
import { bold, dim, paint, palette, write } from './pair-ui';

async function main(): Promise<void> {
  const [command = 'list', argument] = process.argv.slice(2);
  const manager = await openManager();
  await manager.sweep();

  if (command === 'list') {
    write();
    for (const state of await manager.list()) {
      const name = INTEGRATIONS[state.integration].name.padEnd(22);
      const status =
        state.status === 'active'
          ? paint(palette.green, `active   ${state.scopes.join(', ')}  ${dim(`until ${state.expiresAt?.slice(0, 10)}`)}`)
          : state.status === 'pending'
            ? paint(palette.amber, 'waiting for approval')
            : dim('not connected');
      write(`  ${bold(name)} ${status}`);
    }
    const pending = await manager.pendingRequests();
    if (pending.length > 0) {
      write();
      for (const request of pending) {
        write(`  ${paint(palette.amber, '●')} ${request.requestId}  ${INTEGRATIONS[request.integration].name}  ${dim(`from ${request.requestedBy.email ?? request.requestedBy.userId}`)}`);
      }
      write(dim(`\n  Approve with: pnpm grants approve ${pending.length === 1 ? '' : '<request>'}`));
    }
    write();
    return;
  }

  if (command === 'approve' || command === 'deny') {
    const pending = await manager.pendingRequests();
    const request = argument
      ? pending.find((candidate) => candidate.requestId === argument)
      : pending.length === 1
        ? pending[0]
        : undefined;
    if (!request) {
      write(
        pending.length === 0
          ? '  No pending requests.'
          : '  Several requests are pending — name one: pnpm grants approve <request>',
      );
      process.exitCode = 1;
      return;
    }
    if (command === 'deny') {
      await manager.deny(request.requestId);
      write(`  ${paint(palette.red, '✗')}  Denied ${request.requestId}`);
      return;
    }
    await renderRequest(request);
    const outcome = await promptForApproval(manager, request);
    process.exitCode = outcome === 'approved' ? 0 : 1;
    return;
  }

  if (command === 'revoke') {
    if (!isIntegrationId(argument)) {
      write(`  Name an integration: ${Object.keys(INTEGRATIONS).join(', ')}`);
      process.exitCode = 1;
      return;
    }
    const removed = await manager.revoke(argument, 'workstation');
    write(removed ? `  ${paint(palette.green, '✓')}  Revoked ${argument}` : `  ${argument} had no active grant`);
    return;
  }

  write(`  Unknown command "${command}". Use: list, approve, deny, revoke`);
  process.exitCode = 1;
}

main().catch((error: unknown) => {
  console.error(error);
  process.exit(1);
});
