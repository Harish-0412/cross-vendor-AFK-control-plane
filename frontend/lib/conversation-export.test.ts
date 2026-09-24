import { describe, expect, it } from "vitest";

import type { HistoryItem, ImportedConversation } from "./ai-integrations";
import { exportFilename, toJson, toMarkdown } from "./conversation-export";

const conversation: ImportedConversation = {
  id: "codex_dev_1_0194e3a2-7b1c-4f6e-9d2a-5c8b1e4f7a90",
  deviceId: "dev_1",
  externalId: "0194e3a2-7b1c-4f6e-9d2a-5c8b1e4f7a90",
  integration: "codex",
  title: "Fix login: handle expired tokens / refresh!",
  startedAt: "2026-09-10T10:00:00.000Z",
  updatedAt: "2026-09-10T10:30:00.000Z",
  messageCount: 3,
  toolCallCount: 1,
  model: "gpt-5-codex",
  workspace: "~/project",
  hasTranscript: true,
  contentSynced: true,
};

const items: HistoryItem[] = [
  { seq: 0, kind: "user", text: "Fix the login bug" },
  { seq: 1, kind: "tool_call", toolName: "shell", text: "npm test" },
  {
    seq: 2,
    kind: "tool_result",
    text: "Output with a fence inside:\n```ts\nconst x = 1;\n```\nand more",
  },
  { seq: 3, kind: "assistant", text: "Done.", truncated: true },
];

describe("Markdown export", () => {
  const markdown = toMarkdown(conversation, items);

  it("starts with the title and states that content was redacted", () => {
    expect(markdown.startsWith("# Fix login: handle expired tokens / refresh!")).toBe(true);
    expect(markdown).toContain("Secrets were masked on the workstation");
  });

  it("labels each speaker and names the tool", () => {
    expect(markdown).toContain("### You");
    expect(markdown).toContain("### Tool call: shell");
    expect(markdown).toContain("### Assistant");
  });

  it("wraps tool output in a fence longer than any it contains", () => {
    // A three-backtick fence would close at the first ``` inside the output
    // and break the rest of the document.
    expect(markdown).toContain("````\nOutput with a fence inside:\n```ts");
    expect(markdown).toMatch(/and more\n````/);
  });

  it("flags shortened items", () => {
    expect(markdown).toContain("_[shortened]_");
  });

  it("says when the conversation itself was cut short", () => {
    expect(toMarkdown({ ...conversation, contentTruncated: true }, items)).toContain(
      "longer than the sync limit",
    );
  });
});

describe("JSON export", () => {
  it("carries the whole record and every item", () => {
    const parsed = JSON.parse(toJson(conversation, items)) as {
      conversation: ImportedConversation;
      items: HistoryItem[];
      note: string;
    };
    expect(parsed.conversation.id).toBe(conversation.id);
    expect(parsed.items).toHaveLength(items.length);
    expect(parsed.note).toContain("redacted");
  });
});

describe("export filename", () => {
  it("is safe on every platform and still recognisable", () => {
    const name = exportFilename(conversation, "md");
    expect(name).toBe("codex-2026-09-10-fix-login-handle-expired-tokens-refresh.md");
    expect(name).not.toMatch(/[\\/:*?"<>|]/);
  });

  it("falls back to a generic name for an untitled conversation", () => {
    expect(exportFilename({ ...conversation, title: "" }, "json")).toBe(
      "codex-2026-09-10-conversation.json",
    );
    expect(exportFilename({ ...conversation, title: "!!!" }, "json")).toBe(
      "codex-2026-09-10-conversation.json",
    );
  });
});
