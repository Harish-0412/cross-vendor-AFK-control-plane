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
  HISTORY_LIMITS,
  INTEGRATIONS,
  isIntegrationId,
  isIntegrationScope,
  type ConversationSearchMatch,
  type GrantRequestCommand,
  type HistorySearchInfo,
  type IntegrationGrantState,
  type IntegrationScope,
} from '@odysseus/protocol';

import type { IDatabase, IntegrationGrantRecord } from '../db/types';
import type { AuditLog } from '../policy/audit-log';
import type { TunnelServer } from '../tunnel/tunnel-server';
import type { DeviceRecord } from '../types';

import { buildSearchText, type HistoryIngest } from './history-ingest';

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
    private readonly ingest?: HistoryIngest,
  ) {}

  // ------------------------------------------------------------ history

  /** Ask the device to rescan titles/metadata (and usage, if granted) now. */
  async requestSync(device: DeviceRecord, integration: unknown) {
    if (!isIntegrationId(integration)) throw new IntegrationAccessError(404, 'Unknown integration');
    const record = await this.db.integrationGrants.find(device.id, integration);
    if (record?.status !== 'active') {
      throw new IntegrationAccessError(409, 'Connect this integration before syncing it');
    }
    return this.command(device.id, 'integration.sync', { integration });
  }

  /**
   * Ask the device for one conversation's content. Only the conversation id
   * is sent; the gateway maps it to a file from its own scan, so nothing the
   * web app sends can name a path.
   */
  async requestContent(user: { id: string }, id: string) {
    const record = await this.db.externalConversations.find(id);
    if (!record || record.userId !== user.id)
      throw new IntegrationAccessError(404, 'Conversation not found');
    if (!record.hasTranscript)
      throw new IntegrationAccessError(409, 'The tool kept no transcript for this conversation');
    return this.command(record.deviceId, 'integration.sync_content', {
      integration: record.integration,
      externalId: record.externalId,
    });
  }

  /**
   * The user's imported conversations, newest first, optionally filtered by a
   * search.
   *
   * A search looks at titles, folders and — for conversations whose content
   * has been synced — the messages themselves. The response says how many of
   * each there were, because "no results" means something different when most
   * conversations only have a title here.
   */
  async listHistory(
    user: { id: string },
    filter: {
      integration?: string | undefined;
      deviceId?: string | undefined;
      query?: string | undefined;
    },
  ) {
    const records = await this.db.externalConversations.listByUser(user.id, {
      ...(isIntegrationId(filter.integration) ? { integration: filter.integration } : {}),
      ...(filter.deviceId ? { deviceId: filter.deviceId } : {}),
    });

    const strip = ({
      lastScanId: _scan,
      tokensRecorded: _t,
      updatedRecordAt: _u,
      // The index is an implementation detail and can be 40 KB; it is never
      // sent to the browser, only searched here.
      searchText: _s,
      ...rest
    }: (typeof records)[number]) => rest;

    const needle = (filter.query ?? '').trim().toLowerCase();
    const byNewest = (a: { updatedAt: string }, b: { updatedAt: string }) =>
      Date.parse(b.updatedAt) - Date.parse(a.updatedAt);

    if (!needle) return { conversations: records.map(strip).sort(byNewest) };

    const matched = records.flatMap((record) => {
      const match = findMatch(record, needle);
      return match ? [{ ...strip(record), match }] : [];
    });

    return {
      conversations: matched.sort(byNewest),
      search: {
        query: needle,
        searchableConversations: records.filter((record) => record.searchText).length,
        titleOnlyConversations: records.filter((record) => !record.searchText).length,
      } satisfies HistorySearchInfo,
    };
  }

  async getConversation(user: { id: string }, id: string) {
    const record = await this.db.externalConversations.find(id);
    if (!record || record.userId !== user.id)
      throw new IntegrationAccessError(404, 'Conversation not found');
    const {
      lastScanId: _scan,
      tokensRecorded: _t,
      updatedRecordAt: _u,
      searchText: _s,
      ...conversation
    } = record;
    const items = record.contentSynced ? await this.db.externalConversations.readItems(id) : [];

    // Conversations whose content was synced before the search index existed
    // have items but no index. Opening one is already a read of every item, so
    // the index is built here rather than by a migration or a re-sync.
    if (record.contentSynced && !record.searchText && items.length > 0) {
      await this.db.externalConversations.upsert({ ...record, searchText: buildSearchText(items) });
    }
    return { conversation, items };
  }

  async listUsage(user: { id: string }) {
    const records = await this.db.providerUsage.listByUser(user.id);
    return records.map((record) => ({
      deviceId: record.deviceId,
      integration: record.integration,
      snapshot: record.snapshot,
      receivedAt: record.receivedAt.toISOString(),
    }));
  }

  private async command(deviceId: string, commandType: string, payload: Record<string, unknown>) {
    const response = await this.tunnel.sendCommandToDevice(deviceId, commandType, payload, 20_000);
    if (!response.delivered) {
      throw new IntegrationAccessError(
        409,
        'The workstation is offline. Start the gateway and try again.',
      );
    }
    const result = response.payload as
      { success?: boolean; error?: string; result?: unknown } | undefined;
    if (!response.acknowledged || !result?.success) {
      throw new IntegrationAccessError(422, result?.error ?? 'The workstation could not do that');
    }
    return { accepted: true, result: result.result };
  }

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
    // Synced history goes with the grant (the user chose delete-on-revoke).
    await this.ingest?.purge(device.id, integration);
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

    const dataKinds = ['history_summaries', 'history_content', 'usage_snapshot', 'sync_failed'];
    if (typeof update?.kind === 'string' && dataKinds.includes(update.kind)) {
      if (!this.ingest) return;
      const integration = (payload as { integration?: unknown }).integration;
      if (!isIntegrationId(integration)) return;
      // Data is only accepted while the integration is connected. Anything
      // arriving after a revoke — including a scan already in flight — is
      // dropped, so a revoke really does stop the flow.
      const grant = await this.db.integrationGrants.find(deviceId, integration);
      if (!grant || grant.status !== 'active') return;
      const change = await this.ingest.ingest(device, payload as Record<string, unknown>);
      if (change) {
        this.notify(device.userId, {
          type: 'integration_data',
          deviceId,
          integration,
          kind: update.kind,
          change,
        });
      }
      return;
    }

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

      if (status === 'revoked' || status === 'expired') {
        await this.ingest?.purge(deviceId, state.integration);
      }

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

/**
 * Where a lowercased needle first appears in one conversation.
 *
 * Title and folder are checked before the message index so that a result list
 * shows the most recognisable reason for the match. Nothing is scored or
 * ranked: results stay in time order, because "the one I was working on
 * yesterday" is how people actually look for a session.
 */
function findMatch(
  record: { title: string; workspace?: string | undefined; searchText?: string | undefined },
  needle: string,
): ConversationSearchMatch | null {
  const title = record.title.toLowerCase();
  if (title.includes(needle)) {
    return { field: 'title', excerpt: excerptAround(record.title, title.indexOf(needle)), hits: 1 };
  }

  const workspace = record.workspace?.toLowerCase();
  if (workspace?.includes(needle)) {
    return {
      field: 'workspace',
      excerpt: record.workspace ?? '',
      hits: 1,
    };
  }

  const text = record.searchText;
  if (!text) return null;
  const at = text.indexOf(needle);
  if (at === -1) return null;
  return { field: 'messages', excerpt: excerptAround(text, at), hits: countHits(text, needle) };
}

/** Bounded: a needle of one character in a 40 KB index must not be counted 40 000 times. */
function countHits(text: string, needle: string): number {
  let hits = 0;
  let from = 0;
  while (hits < 99) {
    const at = text.indexOf(needle, from);
    if (at === -1) break;
    hits += 1;
    from = at + needle.length;
  }
  return hits;
}

function excerptAround(text: string, at: number): string {
  const context = HISTORY_LIMITS.searchExcerptContext;
  const start = Math.max(0, at - context);
  const end = Math.min(text.length, at + context * 2);
  const body = text.slice(start, end).replace(/\s+/g, ' ').trim();
  return `${start > 0 ? '…' : ''}${body}${end < text.length ? '…' : ''}`;
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
