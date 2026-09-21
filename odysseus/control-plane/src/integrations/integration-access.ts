/**
 * The Control Plane's side of integration access.
 *
 * It can ask a gateway for access and it can revoke — it cannot grant. The
 * gateway holds the signed grant and checks it before every read; what this
 * service stores is a copy for the web app to display. Nothing here, and no
 * record in the database, causes anything to be readable.
 */
import { createHash, randomBytes, randomInt, randomUUID } from 'node:crypto';

import {
  GRANT_REQUEST_TTL_MS,
  INTEGRATIONS,
  isIntegrationId,
  isIntegrationScope,
  type GrantRequestCommand,
  type IntegrationGrantState,
  type IntegrationScope,
} from '@odysseus/protocol';

import type { IDatabase, IntegrationGrantRecord } from '../db/types';
import type { AuditLog } from '../policy/audit-log';
import type { TunnelServer } from '../tunnel/tunnel-server';
import type { DeviceRecord } from '../types';

/** No 0/O, 1/I/L: the code is read off one screen and typed into another. */
const CODE_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';

export class IntegrationAccessError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

export interface IntegrationNotifier {
  (userId: string, message: Record<string, unknown>): void;
}

export class IntegrationAccessService {
  constructor(
    private readonly db: IDatabase,
    private readonly tunnel: TunnelServer,
    private readonly audit: AuditLog,
    private readonly notify: IntegrationNotifier = () => undefined,
  ) {}

  catalog() {
    return Object.values(INTEGRATIONS);
  }

  async listForDevice(device: DeviceRecord) {
    const records = await this.db.integrationGrants.listByDevice(device.id);
    return this.catalog().map((definition) => {
      const record = records.find((candidate) => candidate.integration === definition.id);
      return {
        ...definition,
        state: record
          ? toState(record)
          : { integration: definition.id, status: 'revoked', scopes: [] },
        revokePending: Boolean(record && isRevokePending(record)),
      };
    });
  }

  /**
   * Ask the device for access. Returns the confirmation code — shown only to
   * this browser — that the owner types at the workstation to approve.
   */
  async requestAccess(
    user: { id: string; email?: string | undefined },
    device: DeviceRecord,
    integration: unknown,
    scopes: unknown,
  ): Promise<{
    requestId: string;
    confirmationCode: string;
    expiresAt: string;
    scopes: IntegrationScope[];
  }> {
    if (!isIntegrationId(integration)) throw new IntegrationAccessError(404, 'Unknown integration');

    const offered = INTEGRATIONS[integration].scopes;
    const requested = Array.isArray(scopes) ? scopes : [];
    if (requested.length === 0) throw new IntegrationAccessError(400, 'Choose at least one scope');
    for (const scope of requested) {
      if (!isIntegrationScope(scope) || !offered.includes(scope)) {
        throw new IntegrationAccessError(400, `${String(scope)} is not offered by ${integration}`);
      }
    }
    const cleanScopes = [...new Set(requested)] as IntegrationScope[];

    const code = generateConfirmationCode();
    const salt = randomBytes(16).toString('hex');
    const requestId = `req_${randomUUID().replace(/-/g, '')}`;
    const expiresAt = new Date(Date.now() + GRANT_REQUEST_TTL_MS).toISOString();

    const command: GrantRequestCommand = {
      requestId,
      integration,
      scopes: cleanScopes,
      requestedBy: { userId: user.id, ...(user.email ? { email: user.email } : {}) },
      // Only the salted hash goes to the gateway. The code itself is returned
      // to this browser and stored nowhere.
      confirmation: { salt, sha256: hashConfirmationCode(code, salt) },
      expiresAt,
    };

    const response = await this.tunnel.sendCommandToDevice(
      device.id,
      'integration.grant_request',
      command,
      15_000,
    );
    if (!response.delivered) {
      throw new IntegrationAccessError(
        409,
        'The workstation is offline. Start the gateway and try again.',
      );
    }
    const result = response.payload as { success?: boolean; error?: string } | undefined;
    if (!response.acknowledged || !result?.success) {
      throw new IntegrationAccessError(
        422,
        result?.error ?? 'The workstation did not accept the request',
      );
    }

    await this.db.integrationGrants.upsert({
      deviceId: device.id,
      userId: device.userId,
      integration,
      status: 'pending',
      scopes: cleanScopes,
      requestId,
      expiresAt,
    });
    await this.audit.record({
      actor: { type: 'user', id: user.id },
      deviceId: device.id,
      action: `integration.${integration}.requested`,
      decision: 'require_approval',
    });

    return { requestId, confirmationCode: formatCode(code), expiresAt, scopes: cleanScopes };
  }

  /**
   * Revoke from the web. When the device is offline the revoke is recorded
   * and delivered the moment it reconnects — a revoke must not be lost just
   * because the machine was asleep.
   */
  async revoke(user: { id: string }, device: DeviceRecord, integration: unknown) {
    if (!isIntegrationId(integration)) throw new IntegrationAccessError(404, 'Unknown integration');

    const response = await this.tunnel.sendCommandToDevice(
      device.id,
      'integration.revoke',
      { integration },
      15_000,
    );
    const delivered =
      response.delivered &&
      response.acknowledged &&
      (response.payload as { success?: boolean } | undefined)?.success === true;

    await this.db.integrationGrants.upsert({
      deviceId: device.id,
      userId: device.userId,
      integration,
      status: 'revoked',
      scopes: [],
      reason: delivered ? 'Revoked from the web app' : REVOKE_PENDING,
    });
    await this.audit.record({
      actor: { type: 'user', id: user.id },
      deviceId: device.id,
      action: `integration.${integration}.revoked`,
      decision: 'denied',
    });
    return { delivered };
  }

  /** Send revokes that were recorded while the device was offline. */
  async deliverPendingRevokes(deviceId: string): Promise<void> {
    const records = await this.db.integrationGrants.listByDevice(deviceId);
    for (const record of records.filter(isRevokePending)) {
      const response = await this.tunnel.sendCommandToDevice(
        deviceId,
        'integration.revoke',
        { integration: record.integration },
        15_000,
      );
      if (response.acknowledged && (response.payload as { success?: boolean })?.success) {
        await this.db.integrationGrants.upsert({ ...record, reason: 'Revoked from the web app' });
      }
    }
  }

  /**
   * A state change or refused read reported by the gateway.
   *
   * The owner recorded is always the device's owner from the database, never a
   * user id the gateway sent: a gateway speaks only for its own device.
   */
  async handleGatewayUpdate(deviceId: string, payload: unknown): Promise<void> {
    const device = await this.db.devices.findById(deviceId);
    if (!device) return;
    const update = payload as { kind?: unknown } | undefined;

    if (update?.kind === 'grant_changed') {
      const state = (payload as { state?: Partial<IntegrationGrantState> }).state;
      if (!state || !isIntegrationId(state.integration)) return;
      const status = state.status;
      if (!status || !['pending', 'active', 'denied', 'revoked', 'expired'].includes(status))
        return;

      const existing = await this.db.integrationGrants.find(deviceId, state.integration);
      // A revoke waiting for delivery must not be overwritten by a stale
      // "active" report; it stays pending until the gateway confirms it.
      if (existing && isRevokePending(existing) && status === 'active') {
        await this.deliverPendingRevokes(deviceId);
        return;
      }

      const scopes = (Array.isArray(state.scopes) ? state.scopes : []).filter(isIntegrationScope);
      await this.db.integrationGrants.upsert({
        deviceId,
        userId: device.userId,
        integration: state.integration,
        status,
        scopes,
        ...(state.requestId ? { requestId: String(state.requestId) } : {}),
        ...(state.grantId ? { grantId: String(state.grantId) } : {}),
        ...(Array.isArray(state.roots) ? { roots: state.roots.map(String).slice(0, 8) } : {}),
        ...(state.grantedAt ? { grantedAt: String(state.grantedAt) } : {}),
        ...(state.expiresAt ? { expiresAt: String(state.expiresAt) } : {}),
        ...(state.reason ? { reason: String(state.reason).slice(0, 300) } : {}),
      });

      if (status !== 'pending') {
        await this.audit.record({
          actor: { type: 'device', id: deviceId },
          deviceId,
          action: `integration.${state.integration}.${status}`,
          decision: status === 'active' ? 'granted' : 'denied',
        });
      }
      this.notify(device.userId, {
        type: 'integration_update',
        deviceId,
        state: { ...state, scopes },
      });
      return;
    }

    if (update?.kind === 'access_refused') {
      const refused = payload as { integration?: unknown; scope?: unknown; reason?: unknown };
      if (!isIntegrationId(refused.integration)) return;
      await this.audit.record({
        actor: { type: 'device', id: deviceId },
        deviceId,
        action: `integration.${refused.integration}.access_refused`,
        decision: 'deny',
      });
    }
  }
}

const REVOKE_PENDING = 'Revoke waiting for the workstation to come online';

function isRevokePending(record: IntegrationGrantRecord): boolean {
  return record.status === 'revoked' && record.reason === REVOKE_PENDING;
}

function toState(record: IntegrationGrantRecord): IntegrationGrantState {
  return {
    integration: record.integration,
    status: record.status,
    scopes: record.scopes,
    requestId: record.requestId,
    grantId: record.grantId,
    roots: record.roots,
    grantedAt: record.grantedAt,
    expiresAt: record.expiresAt,
    reason: record.reason,
  };
}

function generateConfirmationCode(length = 6): string {
  let code = '';
  for (let i = 0; i < length; i += 1) code += CODE_ALPHABET[randomInt(CODE_ALPHABET.length)];
  return code;
}

function formatCode(code: string): string {
  return `${code.slice(0, 3)}-${code.slice(3)}`;
}

/** Same scheme as the gateway: sha256(`${salt}:${normalised code}`). */
export function hashConfirmationCode(code: string, salt: string): string {
  const normalised = code.toUpperCase().replace(/[^A-Z0-9]/g, '');
  return createHash('sha256').update(`${salt}:${normalised}`).digest('hex');
}
