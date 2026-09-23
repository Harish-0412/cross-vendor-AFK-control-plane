/**
 * Storing history and usage a gateway reports for a granted integration.
 *
 * The gateway is authenticated, but its data is still validated and bounded
 * here: a buggy or compromised gateway must not be able to write unbounded or
 * malformed records, or data for another device. Everything is attributed to
 * the device the socket authenticated as, and owned by that device's owner.
 */
import {
  HISTORY_LIMITS,
  isIntegrationId,
  type ExternalConversationSummary,
  type HistoryItem,
  type HistoryItemKind,
  type IntegrationId,
  type ProviderUsageSnapshot,
  type TokenTotals,
} from '@odysseus/protocol';

import type { ExternalConversationRecord, IDatabase } from '../db/types';
import type { CostGovernor } from '../orchestration/cost-governor';
import type { DeviceRecord } from '../types';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const ITEM_KINDS: HistoryItemKind[] = [
  'user',
  'assistant',
  'thinking',
  'tool_call',
  'tool_result',
  'tool_error',
  'system',
  'error',
];

export function conversationId(
  integration: IntegrationId,
  deviceId: string,
  externalId: string,
): string {
  return `${integration}_${deviceId}_${externalId}`;
}

const isoOrNull = (value: unknown): string | null => {
  if (typeof value !== 'string') return null;
  const parsed = Date.parse(value);
  return Number.isNaN(parsed) ? null : new Date(parsed).toISOString();
};

const count = (value: unknown): number =>
  typeof value === 'number' && Number.isFinite(value) && value >= 0
    ? Math.min(Math.floor(value), 1e9)
    : 0;

const shortString = (value: unknown, max: number): string | undefined =>
  typeof value === 'string' && value ? value.slice(0, max) : undefined;

function validTokens(value: unknown): TokenTotals | undefined {
  if (!value || typeof value !== 'object') return undefined;
  const t = value as Record<string, unknown>;
  if (typeof t['total'] !== 'number') return undefined;
  return {
    input: count(t['input']),
    cachedInput: count(t['cachedInput']),
    ...(typeof t['cacheWriteInput'] === 'number'
      ? { cacheWriteInput: count(t['cacheWriteInput']) }
      : {}),
    output: count(t['output']),
    reasoning: count(t['reasoning']),
    total: count(t['total']),
  };
}

function validSummary(
  value: unknown,
  integration: IntegrationId,
): ExternalConversationSummary | null {
  if (!value || typeof value !== 'object') return null;
  const s = value as Record<string, unknown>;
  if (typeof s['externalId'] !== 'string' || !UUID.test(s['externalId'])) return null;
  const startedAt = isoOrNull(s['startedAt']);
  const updatedAt = isoOrNull(s['updatedAt']) ?? startedAt;
  if (!startedAt || !updatedAt) return null;
  const tokens = validTokens(s['tokens']);
  const model = shortString(s['model'], 80);
  const workspace = shortString(s['workspace'], 240);
  return {
    externalId: s['externalId'],
    integration,
    title: shortString(s['title'], HISTORY_LIMITS.titleChars + 1) ?? '',
    startedAt,
    updatedAt,
    messageCount: count(s['messageCount']),
    toolCallCount: count(s['toolCallCount']),
    ...(model ? { model } : {}),
    ...(workspace ? { workspace } : {}),
    ...(tokens ? { tokens } : {}),
    hasTranscript: s['hasTranscript'] !== false,
  };
}

function validItem(value: unknown): HistoryItem | null {
  if (!value || typeof value !== 'object') return null;
  const i = value as Record<string, unknown>;
  if (!ITEM_KINDS.includes(i['kind'] as HistoryItemKind)) return null;
  if (typeof i['text'] !== 'string') return null;
  const at = isoOrNull(i['at']);
  const toolName = shortString(i['toolName'], 80);
  return {
    seq: count(i['seq']),
    kind: i['kind'] as HistoryItemKind,
    text: i['text'].slice(0, HISTORY_LIMITS.itemTextChars + 1),
    ...(toolName ? { toolName } : {}),
    ...(at ? { at } : {}),
    ...(i['truncated'] === true ? { truncated: true } : {}),
  };
}

function validSnapshot(value: unknown): ProviderUsageSnapshot | null {
  if (!value || typeof value !== 'object') return null;
  const s = value as Record<string, unknown>;
  if (s['provider'] === 'openai-org' && s['source'] === 'openai-costs-api') {
    const observedAt = isoOrNull(s['observedAt']);
    const raw = s['organization'];
    if (!observedAt || !raw || typeof raw !== 'object') return null;
    const org = raw as Record<string, unknown>;
    const periodStart = isoOrNull(org['periodStart']);
    const periodEnd = isoOrNull(org['periodEnd']);
    if (!periodStart || !periodEnd || typeof org['totalCost'] !== 'number') return null;
    const money = (value: unknown) =>
      typeof value === 'number' && Number.isFinite(value) && value >= 0 ? Math.min(value, 1e12) : 0;
    const rows = (value: unknown, limit: number) =>
      (Array.isArray(value) ? value : [])
        .slice(0, limit)
        .filter((item) => item && typeof item === 'object') as Record<string, unknown>[];
    return {
      provider: 'openai-org',
      source: 'openai-costs-api',
      observedAt,
      organization: {
        periodStart,
        periodEnd,
        currency: shortString(org['currency'], 12) ?? 'usd',
        totalCost: money(org['totalCost']),
        daily: rows(org['daily'], 62).flatMap((item) => {
          const startTime = isoOrNull(item['startTime']);
          const endTime = isoOrNull(item['endTime']);
          return startTime && endTime
            ? [
                {
                  startTime,
                  endTime,
                  amount: money(item['amount']),
                  currency: shortString(item['currency'], 12) ?? 'usd',
                },
              ]
            : [];
        }),
        byProject: rows(org['byProject'], 200).map((item) => ({
          id: shortString(item['id'], 160) ?? 'unattributed',
          amount: money(item['amount']),
        })),
        byLineItem: rows(org['byLineItem'], 200).map((item) => ({
          name: shortString(item['name'], 160) ?? 'other',
          amount: money(item['amount']),
        })),
        inputTokens: count(org['inputTokens']),
        cachedInputTokens: count(org['cachedInputTokens']),
        outputTokens: count(org['outputTokens']),
        requests: count(org['requests']),
        byModel: rows(org['byModel'], 200).map((item) => ({
          model: shortString(item['model'], 100) ?? 'unknown',
          inputTokens: count(item['inputTokens']),
          outputTokens: count(item['outputTokens']),
          requests: count(item['requests']),
        })),
      },
    };
  }
  if (s['provider'] !== 'codex' || s['source'] !== 'codex-rate-limits') return null;
  const observedAt = isoOrNull(s['observedAt']);
  if (!observedAt) return null;

  const windows = (Array.isArray(s['windows']) ? s['windows'] : [])
    .slice(0, 4)
    .map((w) => {
      const window = (w ?? {}) as Record<string, unknown>;
      const resetsAt = isoOrNull(window['resetsAt']);
      const used = window['usedPercent'];
      const minutes = window['windowMinutes'];
      if (
        (window['name'] !== 'primary' && window['name'] !== 'secondary') ||
        typeof used !== 'number' ||
        !Number.isFinite(used) ||
        typeof minutes !== 'number' ||
        !resetsAt
      ) {
        return null;
      }
      return {
        name: window['name'] === 'primary' ? ('primary' as const) : ('secondary' as const),
        usedPercent: Math.max(0, Math.min(100, used)),
        windowMinutes: Math.max(0, Math.floor(minutes)),
        resetsAt,
      };
    })
    .filter((w): w is NonNullable<typeof w> => w !== null);

  const credits = s['credits'] as Record<string, unknown> | undefined;
  const planType = shortString(s['planType'], 40);
  return {
    provider: 'codex',
    source: 'codex-rate-limits',
    observedAt,
    ...(planType ? { planType } : {}),
    ...(windows.length ? { windows } : {}),
    ...(credits && typeof credits === 'object'
      ? {
          credits: {
            hasCredits: credits['hasCredits'] === true,
            unlimited: credits['unlimited'] === true,
            ...(credits['balance'] != null
              ? { balance: String(credits['balance']).slice(0, 40) }
              : {}),
          },
        }
      : {}),
  };
}

export class HistoryIngest {
  constructor(
    private readonly db: IDatabase,
    private readonly costGovernor?: CostGovernor,
  ) {}

  /** Returns a short description of what changed, for the live notification. */
  async ingest(device: DeviceRecord, update: Record<string, unknown>): Promise<string | null> {
    const integration = update['integration'];
    if (!isIntegrationId(integration)) return null;

    switch (update['kind']) {
      case 'history_summaries':
        return this.ingestSummaries(device, integration, update);
      case 'history_content':
        return this.ingestContent(device, integration, update);
      case 'usage_snapshot':
        return this.ingestUsage(device, integration, update);
      case 'sync_failed':
        return `sync failed: ${String(update['reason'] ?? '').slice(0, 200)}`;
      default:
        return null;
    }
  }

  private async ingestSummaries(
    device: DeviceRecord,
    integration: IntegrationId,
    update: Record<string, unknown>,
  ): Promise<string> {
    const scanId = shortString(update['scanId'], 80) ?? 'scan_unknown';
    const incoming = (Array.isArray(update['conversations']) ? update['conversations'] : [])
      .slice(0, HISTORY_LIMITS.summariesPerMessage)
      .map((value) => validSummary(value, integration))
      .filter((value): value is ExternalConversationSummary => value !== null);

    for (const summary of incoming) {
      const id = conversationId(integration, device.id, summary.externalId);
      const existing = await this.db.externalConversations.find(id);
      const record: ExternalConversationRecord = {
        ...summary,
        id,
        deviceId: device.id,
        userId: device.userId,
        // Content already synced stays; a changed conversation is flagged so
        // the UI can offer to refresh it.
        contentSynced: Boolean(existing?.contentSynced),
        ...(existing?.contentSyncedAt ? { contentSyncedAt: existing.contentSyncedAt } : {}),
        ...(existing?.contentTruncated ? { contentTruncated: true } : {}),
        tokensRecorded: existing?.tokensRecorded ?? 0,
        lastScanId: scanId,
        updatedRecordAt: new Date(),
      };

      // Record only the growth since last time, so re-syncing never double
      // counts. Plan tokens are subscription usage: no dollar figure.
      const total = summary.tokens?.total ?? 0;
      if (this.costGovernor && total > record.tokensRecorded) {
        await this.costGovernor.recordUsage({
          sessionId: id,
          userId: device.userId,
          tokens: total - record.tokensRecorded,
          costUsd: 0,
          billing: 'subscription',
        });
        record.tokensRecorded = total;
      }
      await this.db.externalConversations.upsert(record);
    }

    // After the last batch of a full scan, anything this scan did not see no
    // longer exists on the workstation.
    if (update['complete'] === true) {
      const stale = (
        await this.db.externalConversations.listByDeviceIntegration(device.id, integration)
      )
        .filter((record) => record.lastScanId !== scanId)
        .map((record) => record.id);
      if (stale.length) await this.db.externalConversations.delete(stale);
    }
    return `${incoming.length} conversations`;
  }

  private async ingestContent(
    device: DeviceRecord,
    integration: IntegrationId,
    update: Record<string, unknown>,
  ): Promise<string | null> {
    const externalId = update['externalId'];
    if (typeof externalId !== 'string' || !UUID.test(externalId)) return null;
    const id = conversationId(integration, device.id, externalId);
    const record = await this.db.externalConversations.find(id);
    // Content is only accepted for a conversation already listed for this device.
    if (!record) return null;

    const part = count(update['part']);
    if (part * HISTORY_LIMITS.itemsPerMessage >= HISTORY_LIMITS.itemsPerConversation) return null;
    const items = (Array.isArray(update['items']) ? update['items'] : [])
      .slice(0, HISTORY_LIMITS.itemsPerMessage)
      .map(validItem)
      .filter((item): item is HistoryItem => item !== null);

    await this.db.externalConversations.writeItems(id, part, items);
    if (update['final'] === true) {
      await this.db.externalConversations.upsert({
        ...record,
        contentSynced: true,
        contentSyncedAt: new Date().toISOString(),
        contentTruncated: update['truncated'] === true,
        updatedRecordAt: new Date(),
      });
    }
    return `content part ${part}`;
  }

  private async ingestUsage(
    device: DeviceRecord,
    integration: IntegrationId,
    update: Record<string, unknown>,
  ): Promise<string | null> {
    const snapshot = validSnapshot(update['snapshot']);
    if (!snapshot) return null;
    await this.db.providerUsage.upsert({
      deviceId: device.id,
      userId: device.userId,
      integration,
      snapshot,
      receivedAt: new Date(),
    });
    return 'usage';
  }

  /** Delete everything synced for one integration on one device (on revoke). */
  async purge(deviceId: string, integration: IntegrationId): Promise<number> {
    const records = await this.db.externalConversations.listByDeviceIntegration(
      deviceId,
      integration,
    );
    await this.db.externalConversations.delete(records.map((record) => record.id));
    await this.db.providerUsage.delete(deviceId, integration);
    return records.length;
  }
}
