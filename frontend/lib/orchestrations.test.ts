import { describe, expect, it } from "vitest";

import { orderSteps, type OrchestrationStep } from "./orchestrations";

const step = (id: string, dependsOn: string[] = []): OrchestrationStep => ({
  id,
  title: id,
  taskKind: "implementation",
  prompt: id,
  dependsOn,
  state: "pending",
});

describe("orderSteps", () => {
  it("lists each step after everything it depends on, whatever order they were added in", () => {
    // Fix steps are appended at the end of the plan, but the review that now
    // waits on the re-check must still be shown after it.
    const ordered = orderSteps([
      step("plan"),
      step("build", ["plan"]),
      step("review", ["test-recheck-1"]),
      step("test", ["build"]),
      step("test-fix-1", ["test"]),
      step("test-recheck-1", ["test-fix-1"]),
    ]).map((s) => s.id);
    expect(ordered).toEqual(["plan", "build", "test", "test-fix-1", "test-recheck-1", "review"]);
  });

  it("does not loop on a malformed cycle", () => {
    expect(orderSteps([step("a", ["b"]), step("b", ["a"])]).map((s) => s.id).sort()).toEqual(["a", "b"]);
  });
});
