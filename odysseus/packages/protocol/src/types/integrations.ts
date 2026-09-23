/**
 * External integrations: connecting the history, usage and sessions of tools
 * that live on the workstation (Antigravity, Codex, a ChatGPT export) or in an
 * organisation account (OpenAI org usage).
 *
 * Shared by the web app, the Control Plane and the gateway so all three
 * describe an integration identically. Only the gateway resolves real paths —
 * the descriptions here are what the user reads before asking for access.
 *
 * Access is granted per device, per integration, per scope, and is only ever
 * approved on the workstation. See docs/INTEGRATIONS_PLAN_ANTIGRAVITY_OPENAI.md.
 */

export type IntegrationId = 'antigravity' | 'claude' | 'codex' | 'chatgpt-export' | 'openai-org';

export type IntegrationScope = 'history.read' | 'usage.read' | 'session.run';

export type GrantStatus = 'pending' | 'active' | 'denied' | 'revoked' | 'expired';

export interface IntegrationDefinition {
  id: IntegrationId;
  name: string;
  summary: string;
  /** Scopes this integration can offer. Anything else is refused outright. */
  scopes: IntegrationScope[];
  /** Plain-language description of what each scope reads. */
  reads: Partial<Record<IntegrationScope, string>>;
  /** What leaves the workstation, stated before the user asks for access. */
  leavesMachine: string;
  /** Named explicitly so the user can see they are excluded. */
  neverRead: string[];
}

export const INTEGRATIONS: Record<IntegrationId, IntegrationDefinition> = {
  codex: {
    id: 'codex',
    name: 'OpenAI Codex',
    summary: 'Your Codex sessions, and your ChatGPT plan usage limits as Codex records them.',
    scopes: ['history.read', 'usage.read', 'session.run'],
    reads: {
      'history.read': 'Session files in ~/.codex/sessions (rollout-*.jsonl)',
      'usage.read': 'Token counts and plan rate limits recorded inside those same session files',
      'session.run': 'Start and continue Codex CLI sessions inside a project you select',
    },
    leavesMachine:
      'Session titles and metadata by default; conversation content only for sessions you ' +
      'choose to sync. Session prompts are delivered only while the website is connected. ' +
      'All content is redacted on this machine before it is sent.',
    neverRead: [
      '~/.codex/auth.json (your login)',
      '~/.codex/.sandbox-secrets',
      'Codex databases (*.sqlite) and history.jsonl',
    ],
  },
  antigravity: {
    id: 'antigravity',
    name: 'Google Antigravity',
    summary: 'Your Antigravity conversations that have a saved transcript.',
    scopes: ['history.read'],
    reads: {
      'history.read':
        'Transcripts in ~/.gemini/antigravity/brain/<conversation>/.system_generated/logs',
    },
    leavesMachine:
      'Conversation titles and metadata by default; content only for conversations you choose ' +
      'to sync. All content is redacted on this machine before it is sent.',
    neverRead: [
      'Antigravity login and state files',
      'Browser recordings and media',
      'Databases and protobuf files under ~/.gemini/antigravity',
    ],
  },
  claude: {
    id: 'claude',
    name: 'Claude Code',
    summary: 'Your local Claude Code conversations and the token counts recorded with them.',
    scopes: ['history.read', 'usage.read'],
    reads: {
      'history.read': 'Conversation files in ~/.claude/projects (one JSONL file per session)',
      'usage.read': 'Per-message token usage recorded inside those same conversation files',
    },
    leavesMachine:
      'Session titles and metadata by default; conversation content only for sessions you ' +
      'choose to sync. All content is redacted on this machine before it is sent.',
    neverRead: [
      '~/.claude/.credentials.json and other Claude login files',
      'Claude settings, plugins, shell snapshots and debug logs',
      'Anything outside ~/.claude/projects',
    ],
  },
  'chatgpt-export': {
    id: 'chatgpt-export',
    name: 'ChatGPT export',
    summary: 'Past chatgpt.com conversations, imported from the export ChatGPT lets you download.',
    scopes: ['history.read'],
    reads: {
      'history.read': 'The conversations.json inside an export file you choose to import',
    },
    leavesMachine:
      'Parsed, redacted conversations. The export file itself never leaves this machine.',
    neverRead: ['Anything other than the export file you point the import at'],
  },
  'openai-org': {
    id: 'openai-org',
    name: 'OpenAI organisation',
    summary: 'Daily API spend and token usage for your OpenAI organisation.',
    scopes: ['usage.read'],
    reads: {
      'usage.read':
        "OpenAI's organisation Usage and Costs APIs, called from this machine with an Admin key " +
        'that is stored here',
    },
    leavesMachine: 'Daily totals only. The Admin key never leaves this machine.',
    neverRead: ['Conversations or prompts — the Usage and Costs APIs do not expose them'],
  },
};

export function isIntegrationId(value: unknown): value is IntegrationId {
  return typeof value === 'string' && value in INTEGRATIONS;
}

export function isIntegrationScope(value: unknown): value is IntegrationScope {
  return value === 'history.read' || value === 'usage.read' || value === 'session.run';
}

/** Default lifetime of a grant; the user is asked again after this. */
export const GRANT_TTL_MS = 90 * 24 * 60 * 60 * 1000;

/** How long a pending access request waits for approval on the workstation. */
export const GRANT_REQUEST_TTL_MS = 10 * 60 * 1000;

/**
 * The state of one integration on one device, as the gateway reports it.
 * The gateway is the authority; the Control Plane keeps a copy for display.
 */
export interface IntegrationGrantState {
  integration: IntegrationId;
  status: GrantStatus;
  scopes: IntegrationScope[];
  requestId?: string | undefined;
  grantId?: string | undefined;
  /** Directories the grant covers, as resolved on the workstation. */
  roots?: string[] | undefined;
  grantedAt?: string | undefined;
  expiresAt?: string | undefined;
  /** Set when a request was denied or a read was refused. */
  reason?: string | undefined;
}

/** Payload of the gateway → Control Plane `integration_update` tunnel message. */
export type IntegrationUpdate =
  | IntegrationDataUpdate
  | { kind: 'grant_changed'; state: IntegrationGrantState }
  | {
      kind: 'access_refused';
      integration: IntegrationId;
      scope: IntegrationScope;
      reason: string;
      /** Relative to the integration root when known; never an absolute path. */
      target?: string | undefined;
    };

/** Payload of the `integration.grant_request` command. */
export interface GrantRequestCommand {
  requestId: string;
  integration: IntegrationId;
  scopes: IntegrationScope[];
  requestedBy: { userId: string; email?: string | undefined };
  /**
   * Salted hash of the confirmation code shown only in the requester's browser.
   * The approver types the code at the workstation, which proves the person
   * approving is looking at that browser session — so a request made from a
   * stolen web session cannot be approved by the workstation owner by mistake.
   */
  confirmation: { salt: string; sha256: string };
  expiresAt: string;
}

// --------------------------------------------------------------- history

/** Hard limits on what one sync may send, so a huge session cannot flood the tunnel or the database. */
export const HISTORY_LIMITS = {
  titleChars: 120,
  itemTextChars: 4000,
  itemsPerConversation: 3000,
  itemsPerMessage: 200,
  summariesPerMessage: 100,
} as const;

export interface TokenTotals {
  /** Non-cached input tokens exactly as the provider reported them. */
  input: number;
  /** Cache-read input tokens. */
  cachedInput: number;
  /** Cache-creation/write tokens, when the provider reports them separately. */
  cacheWriteInput?: number | undefined;
  output: number;
  reasoning: number;
  /** Sum of every reported token class; cached tokens are counted once. */
  total: number;
}

/**
 * One past conversation, as listed before any content is synced. The title is
 * derived from the first message the user typed, redacted and shortened on the
 * workstation; nothing else from the conversation is included.
 */
export interface ExternalConversationSummary {
  /** The tool's own id for the conversation (Codex session / Antigravity conversation UUID). */
  externalId: string;
  integration: IntegrationId;
  title: string;
  startedAt: string;
  updatedAt: string;
  messageCount: number;
  toolCallCount: number;
  model?: string | undefined;
  /** Working folder, shown as a ~ path. */
  workspace?: string | undefined;
  /** Present only when the grant includes usage.read. */
  tokens?: TokenTotals | undefined;
  /** False when the tool kept no readable transcript for this conversation. */
  hasTranscript: boolean;
}

export type HistoryItemKind =
  | 'user'
  | 'assistant'
  | 'thinking'
  | 'tool_call'
  | 'tool_result'
  | 'tool_error'
  | 'system'
  | 'error';

export interface HistoryItem {
  seq: number;
  kind: HistoryItemKind;
  /** Redacted on the workstation. */
  text: string;
  toolName?: string | undefined;
  at?: string | undefined;
  /** Text was cut to HISTORY_LIMITS.itemTextChars. */
  truncated?: boolean | undefined;
}

// ----------------------------------------------------------------- usage

export interface UsageWindow {
  name: 'primary' | 'secondary';
  usedPercent: number;
  windowMinutes: number;
  resetsAt: string;
}

/**
 * Remaining-usage figures for a provider, with where they came from and when.
 * A field that the source did not report is absent — never defaulted.
 */
export interface ProviderUsageSnapshot {
  provider: 'codex' | 'openai-org';
  source: 'codex-rate-limits' | 'openai-costs-api';
  observedAt: string;
  planType?: string | undefined;
  windows?: UsageWindow[] | undefined;
  credits?: { hasCredits: boolean; unlimited: boolean; balance?: string | undefined } | undefined;
  /** Present only for the organization Usage/Costs APIs. Values are provider-reported, never estimated. */
  organization?: OpenAiOrgUsage | undefined;
}

export interface OpenAiOrgUsage {
  periodStart: string;
  periodEnd: string;
  currency: string;
  totalCost: number;
  daily: Array<{ startTime: string; endTime: string; amount: number; currency: string }>;
  byProject: Array<{ id: string; amount: number }>;
  byLineItem: Array<{ name: string; amount: number }>;
  inputTokens: number;
  cachedInputTokens: number;
  outputTokens: number;
  requests: number;
  byModel: Array<{ model: string; inputTokens: number; outputTokens: number; requests: number }>;
}

/** Everything a gateway may report about an integration, carried by `integration_update`. */
export type IntegrationDataUpdate =
  | {
      kind: 'history_summaries';
      integration: IntegrationId;
      conversations: ExternalConversationSummary[];
      /** True on the last batch of a full scan; conversations not seen by then are gone. */
      complete: boolean;
      scanId: string;
    }
  | {
      kind: 'history_content';
      integration: IntegrationId;
      externalId: string;
      items: HistoryItem[];
      part: number;
      final: boolean;
      /** The conversation had more items than HISTORY_LIMITS.itemsPerConversation. */
      truncated: boolean;
    }
  | { kind: 'usage_snapshot'; integration: IntegrationId; snapshot: ProviderUsageSnapshot }
  | { kind: 'sync_failed'; integration: IntegrationId; reason: string };
