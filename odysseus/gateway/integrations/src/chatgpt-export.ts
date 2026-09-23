import { mkdir, readFile, readdir, rm, stat } from 'node:fs/promises';
import { basename, join, resolve } from 'node:path';
import { unzipSync } from 'fflate';
import type { ExternalConversationSummary, HistoryItem } from '@odysseus/protocol';
import { readJsonFile, writeJsonFileAtomic } from './atomic-file';
import type { IntegrationManager } from './integration-manager';
import type { PathContext } from './paths';
import { prepareText, redact, toIso, toTitle, UUID_PATTERN } from './sync/text';

interface StoredChatGptConversation {
  summary: ExternalConversationSummary;
  items: HistoryItem[];
}
interface ExportMessage {
  author?: { role?: unknown };
  content?: { parts?: unknown };
  create_time?: unknown;
  recipient?: unknown;
}
interface ExportNode {
  id?: unknown;
  parent?: unknown;
  children?: unknown;
  message?: ExportMessage | null;
}
interface ExportConversation {
  id?: unknown;
  conversation_id?: unknown;
  title?: unknown;
  create_time?: unknown;
  update_time?: unknown;
  current_node?: unknown;
  mapping?: unknown;
}

const MAX_ARCHIVE_BYTES = 2 * 1024 * 1024 * 1024;
const MAX_CONVERSATIONS_JSON_BYTES = 512 * 1024 * 1024;

export class ChatGptExportStore {
  readonly root: string;
  constructor(ctx: PathContext) {
    this.root = join(ctx.odysseusHome, 'imports', 'chatgpt');
  }

  async importArchive(
    path: string,
    manager: IntegrationManager,
  ): Promise<{ imported: number; skipped: number }> {
    const grant = await manager.store.findActive('chatgpt-export');
    if (!grant?.scopes.includes('history.read'))
      throw new Error('ChatGPT export history access is not granted on this workstation');
    const absolute = resolve(path);
    const info = await stat(absolute);
    if (!info.isFile()) throw new Error('The ChatGPT export path is not a file');
    if (info.size > MAX_ARCHIVE_BYTES)
      throw new Error('The ChatGPT export is larger than the 2 GB safety limit');
    const zipped = new Uint8Array(await readFile(absolute));
    const files = unzipSync(zipped, {
      filter: (file) =>
        /(^|\/)conversations\.json$/i.test(file.name) &&
        file.originalSize <= MAX_CONVERSATIONS_JSON_BYTES,
    });
    const entry = Object.entries(files).find(([name]) => /(^|\/)conversations\.json$/i.test(name));
    if (!entry)
      throw new Error(
        'This ZIP does not contain conversations.json, or it exceeds the 512 MB safety limit',
      );
    let raw: unknown;
    try {
      raw = JSON.parse(new TextDecoder().decode(entry[1]));
    } catch {
      throw new Error('conversations.json is not valid JSON');
    }
    if (!Array.isArray(raw)) throw new Error('conversations.json is not an array');
    await mkdir(this.root, { recursive: true, mode: 0o700 });
    let imported = 0;
    let skipped = 0;
    const seen = new Set<string>();
    for (const value of raw) {
      const parsed = parseConversation(value);
      if (!parsed) {
        skipped += 1;
        continue;
      }
      await writeJsonFileAtomic(this.file(parsed.summary.externalId), parsed);
      seen.add(`${parsed.summary.externalId}.json`.toLowerCase());
      imported += 1;
    }
    for (const name of await readdir(this.root)) {
      if (/^[0-9a-f-]{36}\.json$/i.test(name) && !seen.has(name.toLowerCase()))
        await rm(join(this.root, name), { force: true });
    }
    return { imported, skipped };
  }

  async summaries(): Promise<ExternalConversationSummary[]> {
    const records = await this.records();
    return records
      .map((record) => record.summary)
      .sort((a, b) => Date.parse(b.updatedAt) - Date.parse(a.updatedAt));
  }
  async content(id: string): Promise<HistoryItem[]> {
    if (!UUID_PATTERN.test(id)) throw new Error('Invalid ChatGPT conversation id');
    const record = await readJsonFile<StoredChatGptConversation | null>(this.file(id), null);
    if (!record) throw new Error('Imported ChatGPT conversation not found');
    return record.items;
  }
  async purge(): Promise<void> {
    await rm(this.root, { recursive: true, force: true });
  }
  private file(id: string) {
    return join(this.root, `${basename(id)}.json`);
  }
  private async records(): Promise<StoredChatGptConversation[]> {
    let names: string[];
    try {
      names = await readdir(this.root);
    } catch {
      return [];
    }
    const records: StoredChatGptConversation[] = [];
    for (const name of names) {
      if (!/^[0-9a-f-]{36}\.json$/i.test(name)) continue;
      const record = await readJsonFile<StoredChatGptConversation | null>(
        join(this.root, name),
        null,
      );
      if (record?.summary) records.push(record);
    }
    return records;
  }
}

function parseConversation(value: unknown): StoredChatGptConversation | null {
  if (!value || typeof value !== 'object') return null;
  const conversation = value as ExportConversation;
  const idValue = conversation.id ?? conversation.conversation_id;
  const id = typeof idValue === 'string' && UUID_PATTERN.test(idValue) ? idValue : null;
  if (!id || !conversation.mapping || typeof conversation.mapping !== 'object') return null;
  const mapping = conversation.mapping as Record<string, ExportNode>;
  const ordered = currentPath(mapping, conversation.current_node);
  const items: HistoryItem[] = [];
  let toolCallCount = 0;
  for (const node of ordered) {
    const message = node.message;
    if (!message) continue;
    const role = typeof message.author?.role === 'string' ? message.author.role : 'system';
    const rawText = partsText(message.content?.parts);
    if (!rawText) continue;
    const prepared = prepareText(rawText);
    const tool =
      role === 'tool' || (typeof message.recipient === 'string' && message.recipient !== 'all');
    if (tool) toolCallCount += 1;
    items.push({
      seq: items.length,
      kind: tool
        ? 'tool_call'
        : role === 'user'
          ? 'user'
          : role === 'assistant'
            ? 'assistant'
            : 'system',
      text: prepared.text,
      ...(typeof message.recipient === 'string' && message.recipient !== 'all'
        ? { toolName: redact(message.recipient).slice(0, 80) }
        : {}),
      ...(toIso(message.create_time) ? { at: toIso(message.create_time)! } : {}),
      ...(prepared.truncated ? { truncated: true } : {}),
    });
  }
  const startedAt = toIso(conversation.create_time) ?? items[0]?.at ?? new Date(0).toISOString();
  const updatedAt = toIso(conversation.update_time) ?? items.at(-1)?.at ?? startedAt;
  const firstUser = items.find((item) => item.kind === 'user')?.text ?? '';
  const titleRaw = typeof conversation.title === 'string' ? conversation.title : firstUser;
  return {
    summary: {
      externalId: id,
      integration: 'chatgpt-export',
      title: toTitle(titleRaw),
      startedAt,
      updatedAt,
      messageCount: items.length,
      toolCallCount,
      hasTranscript: items.length > 0,
    },
    items,
  };
}

function currentPath(mapping: Record<string, ExportNode>, current: unknown): ExportNode[] {
  const result: ExportNode[] = [];
  const seen = new Set<string>();
  let id = typeof current === 'string' ? current : undefined;
  while (id && !seen.has(id)) {
    seen.add(id);
    const node = mapping[id];
    if (!node) break;
    result.push(node);
    id = typeof node.parent === 'string' ? node.parent : undefined;
  }
  if (result.length) return result.reverse();
  return Object.values(mapping)
    .filter((node) => node.message)
    .sort((a, b) => Number(a.message?.create_time ?? 0) - Number(b.message?.create_time ?? 0));
}

function partsText(parts: unknown): string {
  if (!Array.isArray(parts)) return '';
  return parts
    .map((part) =>
      typeof part === 'string'
        ? part
        : part &&
            typeof part === 'object' &&
            typeof (part as Record<string, unknown>)['text'] === 'string'
          ? String((part as Record<string, unknown>)['text'])
          : '',
    )
    .filter(Boolean)
    .join('\n');
}
