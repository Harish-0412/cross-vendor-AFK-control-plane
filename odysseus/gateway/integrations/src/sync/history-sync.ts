/**
 * Reading history and usage for granted integrations and reporting it.
 *
 * Every read goes through the guard (listAllowedFiles / readGrantedLines), so
 * this cannot see anything a grant does not cover. Two further rules:
 *
 * - The Control Plane never names a file. It asks for a conversation by id;
 *   the id is looked up in an index this process built from its own scan. A
 *   remote party therefore cannot steer a read to an arbitrary path, even one
 *   inside a granted folder.
 * - Titles and metadata sync by default. Content is sent only when the user
 *   asks for one specific conversation.
 */
import { randomUUID } from 'node:crypto';
import { readdir, stat } from 'node:fs/promises';
import { basename, join } from 'node:path';

import {
  HISTORY_LIMITS,
  type ExternalConversationSummary,
  type IntegrationDataUpdate,
  type IntegrationId,
  type ProviderUsageSnapshot,
} from '@odysseus/protocol';

import type { IntegrationManager } from '../integration-manager';
import { displayPath, type PathContext } from '../paths';
import { listAllowedFiles, readGrantedLines, type ListedFile } from '../safe-files';

import { antigravityItems, summariseAntigravity } from './antigravity';
import { claudeItems, summariseClaude } from './claude';
import { codexItems, codexUsage, summariseCodex } from './codex';
import { UUID_PATTERN } from './text';
import { ChatGptExportStore } from '../chatgpt-export';
import { LocalCredentialStore } from '../credential-store';
import { OpenAiOrgClient } from '../openai-org';

/** Integrations whose history lives in files this module can read. */
export const FILE_HISTORY_INTEGRATIONS: IntegrationId[] = [
  'codex',
  'antigravity',
  'claude',
  'chatgpt-export',
];

export interface HistorySyncOptions {
  manager: IntegrationManager;
  ctx: PathContext;
  emit: (update: IntegrationDataUpdate) => void;
  /** Production enables this so local files are read only while a web client is live. */
  requireBrowserPresence?: boolean;
}

interface CachedSummary {
  size: number;
  mtimeMs: number;
  summary: ExternalConversationSummary;
}

export class HistorySync {
  /** `${integration}:${externalId}` → absolute path, from this process's own scan. */
  private readonly index = new Map<string, string>();
  private readonly cache = new Map<string, CachedSummary>();
  private readonly running = new Set<string>();
  private autoTimer: NodeJS.Timeout | undefined;
  private browserPresent: boolean;
  private readonly chatgpt: ChatGptExportStore;
  private readonly credentials: LocalCredentialStore;
  private readonly openai: OpenAiOrgClient;

  constructor(private readonly options: HistorySyncOptions) {
    this.browserPresent = options.requireBrowserPresence !== true;
    this.chatgpt = new ChatGptExportStore(options.ctx);
    this.credentials = new LocalCredentialStore(options.ctx);
    this.openai = new OpenAiOrgClient();
  }

  private get guard() {
    return this.options.manager.guard;
  }

  // ---------------------------------------------------------------- scans

  /** Titles and metadata for every conversation, then usage if granted. */
  async syncAll(integration: IntegrationId): Promise<{ conversations: number }> {
    this.assertBrowserPresent();
    const key = `all:${integration}`;
    if (this.running.has(key)) return { conversations: -1 };
    this.running.add(key);
    try {
      const count = await this.syncSummaries(integration);
      if (await this.hasScope(integration, 'usage.read')) await this.refreshUsage(integration);
      return { conversations: count };
    } catch (error) {
      this.options.emit({ kind: 'sync_failed', integration, reason: (error as Error).message });
      throw error;
    } finally {
      this.running.delete(key);
    }
  }

  async syncSummaries(integration: IntegrationId): Promise<number> {
    this.assertBrowserPresent();
    const summaries =
      integration === 'codex'
        ? await this.scanCodex()
        : integration === 'antigravity'
          ? await this.scanAntigravity()
          : integration === 'claude'
            ? await this.scanClaude()
            : integration === 'chatgpt-export'
              ? await this.scanChatGpt()
              : [];

    const scanId = `scan_${randomUUID().replace(/-/g, '')}`;
    const size = HISTORY_LIMITS.summariesPerMessage;
    if (summaries.length === 0) {
      this.options.emit({
        kind: 'history_summaries',
        integration,
        conversations: [],
        complete: true,
        scanId,
      });
    }
    for (let start = 0; start < summaries.length; start += size) {
      this.options.emit({
        kind: 'history_summaries',
        integration,
        conversations: summaries.slice(start, start + size),
        complete: start + size >= summaries.length,
        scanId,
      });
    }
    return summaries.length;
  }

  private async scanChatGpt(): Promise<ExternalConversationSummary[]> {
    if (!(await this.hasScope('chatgpt-export', 'history.read')))
      throw new Error('ChatGPT export history access is not granted');
    const summaries = await this.chatgpt.summaries();
    for (const summary of summaries)
      this.index.set(`chatgpt-export:${summary.externalId}`, summary.externalId);
    return summaries;
  }

  private async scanCodex(): Promise<ExternalConversationSummary[]> {
    const includeTokens = await this.hasScope('codex', 'usage.read');
    const files = await listAllowedFiles(this.guard, 'codex', 'history.read');
    const summaries: ExternalConversationSummary[] = [];

    for (const file of files) {
      this.assertBrowserPresent();
      const cached = this.cache.get(file.absolutePath);
      if (
        cached &&
        cached.size === file.size &&
        cached.mtimeMs === file.mtimeMs &&
        Boolean(cached.summary.tokens) === includeTokens
      ) {
        this.index.set(`codex:${cached.summary.externalId}`, file.absolutePath);
        summaries.push(cached.summary);
        continue;
      }

      const { lines } = await readGrantedLines(
        this.guard,
        'codex',
        'history.read',
        file.absolutePath,
      );
      const idFromName = basename(file.relativePath, '.jsonl').match(
        /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i,
      )?.[0];
      const parsed = summariseCodex(
        lines.map((line) => line.line),
        { includeTokens, fallbackId: idFromName },
      );
      if (!parsed) continue;

      const { cwd, ...rest } = parsed;
      const summary: ExternalConversationSummary = {
        ...rest,
        integration: 'codex',
        ...(cwd ? { workspace: displayPath(cwd, this.options.ctx) } : {}),
      };
      this.cache.set(file.absolutePath, { size: file.size, mtimeMs: file.mtimeMs, summary });
      this.index.set(`codex:${summary.externalId}`, file.absolutePath);
      summaries.push(summary);
    }
    return summaries.sort((a, b) => Date.parse(b.updatedAt) - Date.parse(a.updatedAt));
  }

  private async scanAntigravity(): Promise<ExternalConversationSummary[]> {
    const access = await this.guard.authorize('antigravity', 'history.read');
    if (!access.allowed) throw new Error(`Access refused: ${access.reason}`);

    const files = await listAllowedFiles(this.guard, 'antigravity', 'history.read');
    // Prefer the untruncated transcript when a conversation has both.
    const byConversation = new Map<string, ListedFile>();
    for (const file of files) {
      this.assertBrowserPresent();
      const conversationId = file.relativePath.split('/')[0] ?? '';
      const existing = byConversation.get(conversationId);
      if (!existing || file.relativePath.endsWith('transcript_full.jsonl')) {
        byConversation.set(conversationId, file);
      }
    }

    const summaries: ExternalConversationSummary[] = [];
    for (const [conversationId, file] of byConversation) {
      this.assertBrowserPresent();
      const cached = this.cache.get(file.absolutePath);
      if (cached && cached.size === file.size && cached.mtimeMs === file.mtimeMs) {
        this.index.set(`antigravity:${conversationId}`, file.absolutePath);
        summaries.push(cached.summary);
        continue;
      }
      const { lines } = await readGrantedLines(
        this.guard,
        'antigravity',
        'history.read',
        file.absolutePath,
      );
      const parsed = summariseAntigravity(
        lines.map((line) => line.line),
        conversationId,
      );
      if (!parsed) continue;
      const summary: ExternalConversationSummary = { ...parsed, integration: 'antigravity' };
      this.cache.set(file.absolutePath, { size: file.size, mtimeMs: file.mtimeMs, summary });
      this.index.set(`antigravity:${conversationId}`, file.absolutePath);
      summaries.push(summary);
    }

    // Conversations Antigravity kept no transcript for are listed as such
    // rather than silently missing. Only directory names are read.
    for (const root of access.grant.roots) {
      this.assertBrowserPresent();
      let entries;
      try {
        entries = await readdir(root, { withFileTypes: true });
      } catch {
        continue;
      }
      for (const entry of entries) {
        this.assertBrowserPresent();
        if (!entry.isDirectory() || entry.isSymbolicLink()) continue;
        if (!UUID_PATTERN.test(entry.name) || byConversation.has(entry.name)) continue;
        const info = await stat(join(root, entry.name)).catch(() => null);
        if (!info) continue;
        const when = new Date(info.mtimeMs).toISOString();
        summaries.push({
          externalId: entry.name,
          integration: 'antigravity',
          title: '',
          startedAt: new Date(info.birthtimeMs || info.mtimeMs).toISOString(),
          updatedAt: when,
          messageCount: 0,
          toolCallCount: 0,
          hasTranscript: false,
        });
      }
    }
    return summaries.sort((a, b) => Date.parse(b.updatedAt) - Date.parse(a.updatedAt));
  }

  private async scanClaude(): Promise<ExternalConversationSummary[]> {
    const includeTokens = await this.hasScope('claude', 'usage.read');
    const files = await listAllowedFiles(this.guard, 'claude', 'history.read');
    const summaries: ExternalConversationSummary[] = [];

    for (const file of files) {
      this.assertBrowserPresent();
      const cached = this.cache.get(file.absolutePath);
      if (
        cached &&
        cached.size === file.size &&
        cached.mtimeMs === file.mtimeMs &&
        Boolean(cached.summary.tokens) === includeTokens
      ) {
        this.index.set(`claude:${cached.summary.externalId}`, file.absolutePath);
        summaries.push(cached.summary);
        continue;
      }

      const { lines } = await readGrantedLines(
        this.guard,
        'claude',
        'history.read',
        file.absolutePath,
      );
      const idFromName = basename(file.relativePath, '.jsonl');
      const parsed = summariseClaude(
        lines.map((line) => line.line),
        { includeTokens, fallbackId: idFromName },
      );
      if (!parsed) continue;

      const { cwd, ...rest } = parsed;
      const summary: ExternalConversationSummary = {
        ...rest,
        integration: 'claude',
        ...(cwd ? { workspace: displayPath(cwd, this.options.ctx) } : {}),
      };
      this.cache.set(file.absolutePath, { size: file.size, mtimeMs: file.mtimeMs, summary });
      this.index.set(`claude:${summary.externalId}`, file.absolutePath);
      summaries.push(summary);
    }

    return summaries.sort((a, b) => Date.parse(b.updatedAt) - Date.parse(a.updatedAt));
  }

  // -------------------------------------------------------------- content

  /**
   * The content of one conversation, sent in parts. The id is looked up in
   * this process's own index — it is never used to build a path.
   */
  async syncContent(integration: IntegrationId, externalId: unknown): Promise<{ items: number }> {
    this.assertBrowserPresent();
    if (typeof externalId !== 'string' || !UUID_PATTERN.test(externalId)) {
      throw new Error('Invalid conversation id');
    }
    if (!FILE_HISTORY_INTEGRATIONS.includes(integration)) {
      throw new Error(`${integration} has no conversation files to read`);
    }

    let path = this.index.get(`${integration}:${externalId}`);
    if (!path) {
      await this.syncSummaries(integration);
      path = this.index.get(`${integration}:${externalId}`);
    }
    if (!path) throw new Error('No readable transcript for that conversation');

    const imported = integration === 'chatgpt-export' ? await this.chatgpt.content(path) : null;
    const raw = imported
      ? []
      : (await readGrantedLines(this.guard, integration, 'history.read', path)).lines.map(
          (line) => line.line,
        );
    const parsed = imported
      ? {
          items: imported.slice(0, HISTORY_LIMITS.itemsPerConversation),
          truncated: imported.length > HISTORY_LIMITS.itemsPerConversation,
        }
      : integration === 'codex'
        ? codexItems(raw)
        : integration === 'claude'
          ? claudeItems(raw)
          : antigravityItems(raw);
    const { items, truncated } = parsed;

    const size = HISTORY_LIMITS.itemsPerMessage;
    const parts = Math.max(1, Math.ceil(items.length / size));
    for (let part = 0; part < parts; part += 1) {
      this.options.emit({
        kind: 'history_content',
        integration,
        externalId,
        items: items.slice(part * size, (part + 1) * size),
        part,
        final: part === parts - 1,
        truncated,
      });
    }
    return { items: items.length };
  }

  // ---------------------------------------------------------------- usage

  /** The latest plan limits Codex recorded. Nothing is sent when none exist. */
  async refreshUsage(integration: IntegrationId): Promise<ProviderUsageSnapshot | null> {
    this.assertBrowserPresent();
    if (integration === 'openai-org') {
      const key = await this.credentials.load('openai-org');
      if (!key)
        throw new Error(
          'OpenAI Admin key is not configured locally. Run: pnpm openai-org configure',
        );
      const snapshot = await this.openai.snapshot(key);
      this.options.emit({ kind: 'usage_snapshot', integration, snapshot });
      return snapshot;
    }
    if (integration !== 'codex') return null;
    const files = await listAllowedFiles(this.guard, 'codex', 'usage.read');
    // Limits are cumulative state: the newest files hold the latest figures.
    const newest = [...files].sort((a, b) => b.mtimeMs - a.mtimeMs).slice(0, 5);

    let latest: ProviderUsageSnapshot | null = null;
    for (const file of newest) {
      this.assertBrowserPresent();
      const { lines } = await readGrantedLines(
        this.guard,
        'codex',
        'usage.read',
        file.absolutePath,
      );
      const snapshot = codexUsage(lines.map((line) => line.line));
      if (
        snapshot &&
        (!latest || Date.parse(snapshot.observedAt) > Date.parse(latest.observedAt))
      ) {
        latest = snapshot;
      }
    }
    if (latest) this.options.emit({ kind: 'usage_snapshot', integration, snapshot: latest });
    return latest;
  }

  // ------------------------------------------------------------ scheduling

  /**
   * Keep granted integrations current: sync now, then every `intervalMs`.
   * Unchanged files are served from cache, so a quiet interval costs only a
   * directory listing.
   */
  startAuto(intervalMs = 5 * 60 * 1000): void {
    if (this.autoTimer) return;
    void this.syncAllActive();
    this.autoTimer = setInterval(() => void this.syncAllActive(), intervalMs);
    this.autoTimer.unref?.();
  }

  /** Sync every integration that currently has an active grant. */
  async syncAllActive(): Promise<void> {
    if (!this.browserPresent) return;
    for (const state of await this.options.manager.list().catch(() => [])) {
      if (state.status !== 'active') continue;
      if (
        !FILE_HISTORY_INTEGRATIONS.includes(state.integration) &&
        state.integration !== 'openai-org'
      )
        continue;
      if (!state.scopes.includes('history.read') && !state.scopes.includes('usage.read')) continue;
      await this.syncAll(state.integration).catch(() => undefined);
    }
  }

  stopAuto(): void {
    if (this.autoTimer) clearInterval(this.autoTimer);
    this.autoTimer = undefined;
  }

  /** Called by the authenticated Control Plane presence bridge. */
  setBrowserPresence(present: boolean): void {
    const becamePresent = present && !this.browserPresent;
    this.browserPresent = present;
    if (becamePresent) void this.syncAllActive();
  }

  isBrowserPresent(): boolean {
    return this.browserPresent;
  }

  /** Forget cached data for an integration, e.g. after a revoke. */
  forget(integration: IntegrationId): void {
    for (const key of [...this.index.keys()]) {
      if (key.startsWith(`${integration}:`)) {
        const path = this.index.get(key);
        if (path) this.cache.delete(path);
        this.index.delete(key);
      }
    }
    if (integration === 'chatgpt-export') void this.chatgpt.purge();
    if (integration === 'openai-org') void this.credentials.remove('openai-org');
  }

  private async hasScope(
    integration: IntegrationId,
    scope: 'history.read' | 'usage.read',
  ): Promise<boolean> {
    // A quiet check: asking the guard would record a refusal every scan for a
    // scope that was simply never requested.
    const grant = await this.options.manager.store.findActive(integration);
    return Boolean(grant?.scopes.includes(scope));
  }

  private assertBrowserPresent(): void {
    if (!this.browserPresent) {
      throw new Error('No active Odysseus web client; local integration reads are paused');
    }
  }
}
