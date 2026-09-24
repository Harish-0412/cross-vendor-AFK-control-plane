import { describe, expect, it } from "vitest";

import { agentLabel, projectName, sessionState, summary } from "./dashboard-model";

const online = { online: true };
const offline = { online: false };

describe("dashboard summary", () => {
  it("says the list could not be loaded instead of claiming anything about it", () => {
    // The failure this guards against: "all clear" printed above an error,
    // because an unreadable list looks exactly like an empty one.
    const result = summary({ devicesError: "503", devices: [], approvals: [], live: [] });
    expect(result.text).toBe("The machine list could not be loaded");
    expect(result.tone).toBe("danger");
  });

  it("asks for a pairing when there genuinely are no machines", () => {
    expect(summary({ devicesError: null, devices: [], approvals: [], live: [] }).text).toBe(
      "Pair a machine to get started",
    );
  });

  it("puts waiting decisions ahead of everything else", () => {
    const result = summary({
      devicesError: null,
      devices: [offline],
      approvals: [{}, {}],
      live: [{}],
    });
    expect(result).toEqual({ text: "2 decisions are waiting for you", tone: "warning" });
  });

  it("uses the singular for one decision and one agent", () => {
    expect(summary({ devicesError: null, devices: [online], approvals: [{}], live: [] }).text).toBe(
      "1 decision is waiting for you",
    );
    expect(summary({ devicesError: null, devices: [online], approvals: [], live: [{}] }).text).toBe(
      "1 agent is working — nothing needs you",
    );
  });

  it("reports every machine offline rather than all clear", () => {
    expect(
      summary({ devicesError: null, devices: [offline, offline], approvals: [], live: [] }),
    ).toEqual({ text: "Your machines are offline", tone: "danger" });
  });

  it("keeps showing the machines it has when a later refresh fails", () => {
    // A refresh error with machines still in hand is not "could not be loaded".
    const result = summary({ devicesError: "timeout", devices: [online], approvals: [], live: [] });
    expect(result.text).toBe("All clear. Nothing is running and nothing needs you");
  });
});

describe("session wording", () => {
  it("marks the states that are still live", () => {
    for (const state of ["running", "initializing", "waiting_for_approval"]) {
      expect(sessionState(state).live).toBe(true);
    }
    for (const state of ["completed", "failed", "cancelled", "paused"]) {
      expect(sessionState(state).live).toBe(false);
    }
  });

  it("calls a waiting session what it is to the reader", () => {
    expect(sessionState("waiting_for_approval")).toMatchObject({ label: "Needs you", tone: "warning" });
    expect(sessionState("crashed").label).toBe("Failed");
  });

  it("falls back to readable text for a state it does not know", () => {
    expect(sessionState("some_new_state").label).toBe("some new state");
  });

  it("names agents, and passes unknown ids through", () => {
    expect(agentLabel("claude-code")).toBe("Claude Code");
    expect(agentLabel("brand-new-agent")).toBe("brand-new-agent");
  });

  it("shows the recognisable last folder of a project path on any platform", () => {
    expect(projectName("C:\\Users\\me\\projects\\recoup-api")).toBe("recoup-api");
    expect(projectName("/home/me/work/site/")).toBe("site");
    expect(projectName("repo")).toBe("repo");
  });
});
