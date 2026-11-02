import { describe, expect, it } from "vitest";
import { AgentTask } from "@warrant/contracts";
import { SCENARIOS, TaskFeed, scenario } from "./index.js";

describe("task feed", () => {
  it("every scenario's tasks match the AgentTask contract and have unique ids", () => {
    for (const name of SCENARIOS) {
      const items = scenario(name, new Date("2026-11-01T12:00:00Z"));
      expect(items.length, name).toBeGreaterThan(0);
      for (const it of items)
        expect(AgentTask.safeParse(it.task).success, it.task.taskId).toBe(true);
      expect(new Set(items.map((i) => i.task.taskId)).size).toBe(items.length);
    }
  });

  it("'all' has benign work and every attack family", () => {
    const labels = scenario("all").map((i) => i.label);
    expect(labels.some((l) => l.benign)).toBe(true);
    expect(new Set(labels.filter((l) => !l.benign).map((l) => l.family))).toEqual(
      new Set([
        "price_rise",
        "payee_swap",
        "prompt_injection",
        "refund_fraud",
        "fake_invoice",
        "sneaky_recurring",
      ]),
    );
  });

  it("take() pops by role and keeps labels for the analyzer", () => {
    const feed = new TaskFeed();
    const total = feed.load(scenario("all"));
    const got = feed.take("support", 10);
    expect(got.every((i) => i.task.role === "support")).toBe(true);
    expect(feed.pending()).toHaveLength(total - got.length);
    expect(feed.labelOf(got[0]?.task.taskId ?? "")).toBeDefined();
  });
});

describe("feed reloads", () => {
  it("a reloaded scenario is new work: fresh task ids and sourceRefs", () => {
    const feed = new TaskFeed();
    feed.load(scenario("normal"));
    feed.load(scenario("normal"));
    const refs = feed.take(undefined, 100).map((i) => i.task.sourceRef);
    expect(new Set(refs).size).toBe(refs.length);
  });
});
