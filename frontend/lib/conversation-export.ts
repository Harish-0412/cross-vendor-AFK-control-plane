// frontend/lib/conversation-export.ts
// Saving one imported conversation to a file.
//
// Everything here works on what the page already has. Nothing is fetched and
// nothing is uploaded: the file is built in the browser from the conversation
// that is on screen, so exporting sends nothing anywhere. What you get is what
// was synced — already redacted on the workstation — and no more.

import type { HistoryItem, ImportedConversation } from "./ai-integrations";

const KIND_HEADING: Record<HistoryItem["kind"], string> = {
  user: "You",
  assistant: "Assistant",
  thinking: "Reasoning",
  tool_call: "Tool call",
  tool_result: "Tool result",
  tool_error: "Tool error",
  system: "System",
  error: "Error",
};

/** Text that goes in a fenced block rather than a paragraph. */
const FENCED: ReadonlySet<HistoryItem["kind"]> = new Set([
  "tool_call",
  "tool_result",
  "tool_error",
]);

export function toMarkdown(
  conversation: ImportedConversation,
  items: HistoryItem[],
): string {
  const meta: string[] = [
    `- Tool: ${conversation.integration}`,
    `- Started: ${new Date(conversation.startedAt).toLocaleString()}`,
    `- Last activity: ${new Date(conversation.updatedAt).toLocaleString()}`,
    `- Messages: ${conversation.messageCount}`,
    `- Tool calls: ${conversation.toolCallCount}`,
  ];
  if (conversation.model) meta.push(`- Model: ${conversation.model}`);
  if (conversation.workspace) meta.push(`- Folder: ${conversation.workspace}`);
  if (conversation.tokens) {
    meta.push(`- Tokens: ${conversation.tokens.total.toLocaleString()}`);
  }

  const body = items.map((item) => {
    const heading = KIND_HEADING[item.kind] ?? item.kind;
    const label = item.toolName ? `${heading}: ${item.toolName}` : heading;
    const when = item.at ? ` _(${new Date(item.at).toLocaleString()})_` : "";
    const shortened = item.truncated ? "\n\n_[shortened]_" : "";
    const fence = fenceFor(item.text);
    const text = FENCED.has(item.kind)
      ? `\n${fence}\n${item.text}\n${fence}`
      : `\n${item.text}`;
    return `### ${label}${when}${text}${shortened}`;
  });

  const notes: string[] = [];
  if (conversation.contentTruncated) {
    notes.push(
      "> This conversation was longer than the sync limit; only its first part is here.",
    );
  }
  notes.push(
    "> Exported from Odysseus. Secrets were masked on the workstation before this content was synced.",
  );

  return [
    `# ${conversation.title || "Untitled conversation"}`,
    "",
    ...meta,
    "",
    ...notes,
    "",
    "---",
    "",
    ...body,
    "",
  ].join("\n");
}

/**
 * A fence long enough to contain the text.
 *
 * Tool output frequently contains code blocks of its own, and a three-backtick
 * fence would end at the first of them, breaking the rest of the document.
 * Markdown allows a longer fence to wrap a shorter one, so the text is kept
 * exactly as it is rather than being altered to fit.
 */
function fenceFor(text: string): string {
  const longestRun = [...text.matchAll(/`+/g)].reduce(
    (longest, match) => Math.max(longest, match[0].length),
    0,
  );
  return "`".repeat(Math.max(3, longestRun + 1));
}

export function toJson(
  conversation: ImportedConversation,
  items: HistoryItem[],
): string {
  return JSON.stringify(
    {
      exportedAt: new Date().toISOString(),
      exportedBy: "odysseus",
      note: "Content was redacted on the workstation before it was synced.",
      conversation,
      items,
    },
    null,
    2,
  );
}

/** A filename that is safe on every platform and still recognisable. */
export function exportFilename(
  conversation: ImportedConversation,
  extension: "md" | "json",
): string {
  const title = (conversation.title || "conversation")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 60);
  const day = conversation.startedAt.slice(0, 10);
  return `${conversation.integration}-${day}-${title || "conversation"}.${extension}`;
}

/** Hand the file to the browser's downloader and release the object URL. */
export function downloadText(
  filename: string,
  contents: string,
  mimeType: string,
): void {
  const url = URL.createObjectURL(new Blob([contents], { type: mimeType }));
  const link = document.createElement("a");
  link.href = url;
  link.download = filename;
  document.body.append(link);
  link.click();
  link.remove();
  // Revoking immediately can cancel the download in some browsers; one turn of
  // the event loop is enough for it to have started.
  setTimeout(() => URL.revokeObjectURL(url), 0);
}
