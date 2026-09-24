import { describe, expect, it } from "vitest";

import { rankCommand } from "./command-rank";

describe("command palette ranking", () => {
  it("does not match letters scattered through a string", () => {
    // The original bug: "bud" matched a session by finding b, u and d apart.
    expect(rankCommand("Claude Code recoup-api HARISH-PC running session", "bud")).toBe(0);
    expect(rankCommand("build-server linux", "bud")).toBe(0);
  });

  it("finds a real substring", () => {
    expect(rankCommand("Budgets Spend, plan limits and usage", "bud")).toBeGreaterThan(0);
  });

  it("ranks the start of the label above the start of a word above the middle", () => {
    const start = rankCommand("History past conversations", "his");
    const word = rankCommand("Conversation history", "his");
    const middle = rankCommand("Machines this", "his");
    expect(start).toBeGreaterThan(word);
    expect(word).toBeGreaterThan(middle);
    expect(middle).toBeGreaterThan(0);
  });

  it("requires every term, so more words narrow the results", () => {
    const value = "Codex cross-vendor-AFK-control-plane HARISH-PC running session";
    expect(rankCommand(value, "codex harish")).toBeGreaterThan(0);
    expect(rankCommand(value, "codex laptop")).toBe(0);
  });

  it("is case-insensitive and ignores surrounding space", () => {
    expect(rankCommand("Audit log", "  AUDIT ")).toBe(1);
  });

  it("matches everything for an empty search", () => {
    expect(rankCommand("anything", "")).toBe(1);
  });
});
