/**
 * Agent Trace (https://agent-trace.dev, spec 0.1.0): a record that ties
 * ranges of lines in a revision to the conversation and contributor that
 * produced them.
 *
 * Odysseus writes one for each agent session and one for each commit it
 * makes, with its own evidence — the session, the agent, and every approval
 * granted along the way — under the reverse-domain key `dev.odysseus`. So a
 * line in the repository answers "which agent wrote this, and who approved
 * it?"
 *
 * Pure and dependency-free: used by the gateway (commits) and the Control
 * Plane (sessions), and safe to import in the web app.
 */

/** The record format version; the schema requires `major.minor`. */
export const AGENT_TRACE_VERSION = '0.1';
export const AGENT_TRACE_MEDIA_TYPE = 'application/vnd.agent-trace.record+json';
/** The git notes ref Odysseus stores commit records under. */
export const AGENT_TRACE_NOTES_REF = 'refs/notes/agent-trace';
/** Vendor namespace for Odysseus's own fields in `metadata`. */
export const ODYSSEUS_TRACE_NAMESPACE = 'dev.odysseus';

export interface AgentTraceContributor {
  type: 'human' | 'ai' | 'mixed' | 'unknown';
  /** models.dev style, e.g. "anthropic/claude-opus-4-5". */
  model_id?: string;
}

export interface AgentTraceRange {
  /** 1-indexed, inclusive, at the recorded revision. */
  start_line: number;
  end_line: number;
  /** `algorithm:hash` of the lines, for tracking them when they move. */
  content_hash?: string;
  contributor?: AgentTraceContributor;
}

export interface AgentTraceConversation {
  url?: string;
  contributor: AgentTraceContributor;
  ranges: AgentTraceRange[];
  related?: Array<{ type: string; url: string }>;
}

export interface AgentTraceFile {
  /** Relative to the repository root. */
  path: string;
  conversations: AgentTraceConversation[];
}

export interface AgentTraceRecord {
  version: string;
  id: string;
  timestamp: string;
  vcs?: { type: 'git' | 'jj' | 'hg' | 'svn'; revision: string };
  tool?: { name: string; version?: string };
  files: AgentTraceFile[];
  metadata?: Record<string, unknown>;
}

/** What Odysseus records about an agent's work, under `dev.odysseus`. */
export interface OdysseusTraceMetadata {
  sessionId: string;
  agentId: string;
  deviceId?: string;
  projectId?: string;
  /** False for a session's working tree, true for a commit Odysseus made. */
  committed: boolean;
  approvals: Array<{
    id: string;
    action: string;
    description: string;
    riskLevel?: string;
    decision: 'granted' | 'denied' | 'timeout' | 'superseded' | 'pending';
    /** A person's display name, "policy" or "system". */
    decidedBy?: string;
    decidedAt?: string;
  }>;
  /** True when the diff was too large to attribute every line. */
  truncated?: boolean;
}

export interface BuildAgentTraceInput {
  id: string;
  timestamp: Date | string;
  /** Unified diff of the work, new-file side is attributed. */
  diff: string;
  contributor: AgentTraceContributor;
  conversationUrl?: string;
  related?: Array<{ type: string; url: string }>;
  vcs?: AgentTraceRecord['vcs'];
  tool?: AgentTraceRecord['tool'];
  metadata?: Record<string, unknown>;
}

export function buildAgentTrace(input: BuildAgentTraceInput): AgentTraceRecord {
  const files: AgentTraceFile[] = addedRanges(input.diff).map((file) => ({
    path: file.path,
    conversations: [
      {
        ...(input.conversationUrl ? { url: input.conversationUrl } : {}),
        contributor: input.contributor,
        ranges: file.ranges,
        ...(input.related?.length ? { related: input.related } : {}),
      },
    ],
  }));
  return {
    version: AGENT_TRACE_VERSION,
    id: input.id,
    timestamp:
      typeof input.timestamp === 'string' ? input.timestamp : input.timestamp.toISOString(),
    ...(input.vcs ? { vcs: input.vcs } : {}),
    ...(input.tool ? { tool: input.tool } : {}),
    files,
    ...(input.metadata ? { metadata: input.metadata } : {}),
  };
}

/**
 * The lines a unified diff adds, as ranges in the new version of each file.
 * Deleted files and pure deletions attribute nothing; binary files are skipped.
 */
export function addedRanges(diff: string): Array<{ path: string; ranges: AgentTraceRange[] }> {
  const files: Array<{ path: string; ranges: AgentTraceRange[] }> = [];
  let current: { path: string; ranges: AgentTraceRange[] } | null = null;
  let newLine = 0;
  let inHunk = false;
  let run: { start: number; lines: string[] } | null = null;

  const closeRun = () => {
    if (current && run && run.lines.length > 0) {
      current.ranges.push({
        start_line: run.start,
        end_line: run.start + run.lines.length - 1,
        content_hash: `murmur3:${murmur3(run.lines.join('\n'))}`,
      });
    }
    run = null;
  };
  const closeFile = () => {
    closeRun();
    if (current && current.ranges.length > 0) files.push(current);
    current = null;
    inHunk = false;
  };

  for (const line of diff.split(/\r?\n/)) {
    if (line.startsWith('diff --git ')) {
      closeFile();
      continue;
    }
    if (!inHunk && line.startsWith('+++ ')) {
      closeRun();
      const target = line.slice(4).trim();
      current = target === '/dev/null' ? null : { path: stripPrefix(target), ranges: [] };
      continue;
    }
    const hunk = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(line);
    if (hunk) {
      closeRun();
      newLine = Number(hunk[1]);
      inHunk = true;
      continue;
    }
    if (!inHunk || !current) continue;
    if (line.startsWith('+')) {
      if (!run) run = { start: newLine, lines: [] };
      run.lines.push(line.slice(1));
      newLine++;
    } else if (line.startsWith('-')) {
      // Removed lines do not move the new-file position.
    } else if (line.startsWith('\\')) {
      // "\ No newline at end of file"
    } else {
      closeRun();
      newLine++;
    }
  }
  closeFile();
  return files;
}

/** models.dev-style id from an agent and the model it reported, when known. */
export function traceModelId(agentId: string, model?: string): string | undefined {
  if (!model) return undefined;
  if (model.includes('/')) return model.slice(0, 250);
  const provider =
    agentId === 'claude-code' || agentId === 'claude-acp' || /^claude/i.test(model)
      ? 'anthropic'
      : agentId === 'codex' || agentId === 'codex-acp' || /^(gpt|o\d|codex)/i.test(model)
        ? 'openai'
        : agentId === 'gemini-acp' || /^gemini/i.test(model)
          ? 'google'
          : undefined;
  return provider ? `${provider}/${model}`.slice(0, 250) : undefined;
}

function stripPrefix(path: string): string {
  const unquoted = path.replace(/^"|"$/g, '');
  return unquoted.replace(/^[ab]\//, '');
}

/** MurmurHash3 x86 32-bit of the UTF-8 bytes, as 8 hex digits. */
export function murmur3(text: string, seed = 0): string {
  const bytes = new TextEncoder().encode(text);
  const c1 = 0xcc9e2d51;
  const c2 = 0x1b873593;
  let h = seed >>> 0;
  const blocks = bytes.length - (bytes.length % 4);
  for (let i = 0; i < blocks; i += 4) {
    let k = bytes[i]! | (bytes[i + 1]! << 8) | (bytes[i + 2]! << 16) | (bytes[i + 3]! << 24);
    k = Math.imul(k, c1);
    k = (k << 15) | (k >>> 17);
    k = Math.imul(k, c2);
    h ^= k;
    h = (h << 13) | (h >>> 19);
    h = (Math.imul(h, 5) + 0xe6546b64) | 0;
  }
  let k = 0;
  const tail = bytes.length % 4;
  if (tail === 3) k ^= bytes[blocks + 2]! << 16;
  if (tail >= 2) k ^= bytes[blocks + 1]! << 8;
  if (tail >= 1) {
    k ^= bytes[blocks]!;
    k = Math.imul(k, c1);
    k = (k << 15) | (k >>> 17);
    k = Math.imul(k, c2);
    h ^= k;
  }
  h ^= bytes.length;
  h ^= h >>> 16;
  h = Math.imul(h, 0x85ebca6b);
  h ^= h >>> 13;
  h = Math.imul(h, 0xc2b2ae35);
  h ^= h >>> 16;
  return (h >>> 0).toString(16).padStart(8, '0');
}
