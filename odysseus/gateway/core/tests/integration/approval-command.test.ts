import type { GatewayOptions } from '@odysseus/protocol';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';

import { createGateway, type GatewayImpl } from '../../src/gateway';

type CommandResult = { success: boolean; result?: unknown; error?: string };

/**
 * `session.approve` is how a decision reaches an agent paused on its own
 * approval request: made by a person, settled by policy, or denied when
 * nobody answered in time.
 */
describe('session.approve tunnel command', () => {
  let gateway: GatewayImpl;
  const run = (payload: Record<string, unknown>) =>
    (
      gateway as unknown as { handleTunnelCommand(command: unknown): Promise<CommandResult> }
    ).handleTunnelCommand({ commandType: 'session.approve', payload });

  beforeEach(() => {
    const options: GatewayOptions = {
      sandboxEnabled: false,
      apiServer: { enabled: false },
      logLevel: 'error',
    };
    gateway = createGateway(options);
  });

  afterEach(async () => {
    await gateway.shutdown(false, 2000);
  });

  test('hands the decision to the adapter under its own request id', async () => {
    const submit = vi.spyOn(gateway, 'submitApproval').mockResolvedValue();
    const denied = await run({
      sessionId: 'sess_1',
      approvalId: 'agent_appr_7',
      decision: 'denied',
      reason: 'Nobody decided before the approval expired, so it was denied.',
    });
    expect(denied).toEqual({ success: true });
    expect(submit).toHaveBeenCalledWith(
      'sess_1',
      'agent_appr_7',
      false,
      'Nobody decided before the approval expired, so it was denied.',
    );

    await run({ sessionId: 'sess_1', approvalId: 'agent_appr_8', decision: 'granted' });
    expect(submit).toHaveBeenLastCalledWith('sess_1', 'agent_appr_8', true, undefined);
  });

  test.each([
    [{ approvalId: 'a', decision: 'granted' }, /sessionId and approvalId/],
    [{ sessionId: 's', decision: 'granted' }, /sessionId and approvalId/],
    [{ sessionId: 's', approvalId: 'a', decision: 'maybe' }, /granted or denied/],
  ])('refuses a malformed decision %j', async (payload, message) => {
    const submit = vi.spyOn(gateway, 'submitApproval').mockResolvedValue();
    const result = await run(payload);
    expect(result.success).toBe(false);
    expect(result.error).toMatch(message);
    expect(submit).not.toHaveBeenCalled();
  });

  test('reports an unknown session instead of throwing', async () => {
    const result = await run({ sessionId: 'sess_missing', approvalId: 'a', decision: 'granted' });
    expect(result.success).toBe(false);
  });
});
