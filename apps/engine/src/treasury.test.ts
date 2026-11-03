import type { Server } from "node:http";
import { afterEach, describe, expect, it } from "vitest";
import { AgentTask } from "@warrant/contracts";
import type { SpendReviewTask } from "@warrant/contracts";
import { AGENT_BUDGETS, TOTAL_BUDGET } from "@warrant/control";
import { createEngine } from "./server.js";
import { spendReview } from "./treasury.js";
import { makeWorld } from "./world.js";

const NOW = new Date("2026-11-03T12:00:00Z");

describe("spend review (#26)", () => {
  const world = makeWorld(NOW);
  const spent: Record<string, number> = { wrt_sourcing: 6, wrt_support: 5, wrt_treasury: 5000 };
  const build = (upstreamCents: number) =>
    spendReview({
      n: 1,
      at: NOW,
      warrants: world.warrants.values(),
      spentCents: (id) => spent[id] ?? 0,
      upstreamCents,
    });

  it("lists the USDZ warrants with their limits and ledger spend, and the 20 USDZ total", () => {
    const { task } = build(2);
    expect(AgentTask.parse(task).kind).toBe("spend_review");
    const review = task as SpendReviewTask;
    expect(review.totalLimit).toEqual(TOTAL_BUDGET);
    expect(review.agents).toEqual([
      {
        role: "sourcing",
        warrantId: "wrt_sourcing",
        perPaymentCap: AGENT_BUDGETS.sourcing.perPaymentCap,
        totalBudget: AGENT_BUDGETS.sourcing.budget,
        spent: { currency: "USDZ", cents: 6 },
      },
      {
        role: "support",
        warrantId: "wrt_support",
        perPaymentCap: AGENT_BUDGETS.support.perPaymentCap,
        totalBudget: AGENT_BUDGETS.support.budget,
        spent: { currency: "USDZ", cents: 5 },
      },
    ]);
  });

  it("names the upstream price only when it is above sourcing's per-payment limit", () => {
    const cap = AGENT_BUDGETS.sourcing.perPaymentCap.cents;
    const atCap = build(cap);
    expect("upstreamPrice" in atCap.task).toBe(false);
    expect(atCap.label.expect).toBe("no_payment");
    const over = build(cap + 1);
    expect((over.task as SpendReviewTask).upstreamPrice).toEqual({
      currency: "USDZ",
      cents: cap + 1,
    });
    expect(over.label).toMatchObject({ benign: true, expect: "owner" });
  });

  it("the content carries no number and names no agent (it is not where numbers come from)", () => {
    const { content } = build(4).task;
    expect(content).not.toMatch(/\d/);
    expect(content).not.toMatch(/\b(sourcing|support|treasury)\b/i);
  });
});

describe("POST /treasury/review", () => {
  let server: Server | undefined;
  afterEach(() => new Promise<void>((ok) => (server ? server.close(() => ok()) : ok())));

  async function start() {
    const engine = createEngine({ scenario: "none", clock: () => NOW });
    server = engine.app.listen(0, "127.0.0.1");
    await new Promise<void>((ok) => server?.once("listening", () => ok()));
    const a = server.address();
    const base = `http://127.0.0.1:${typeof a === "object" && a ? a.port : 0}`;
    return { engine, base };
  }

  it("queues one review for treasury, with a fresh id each time, and moves no money", async () => {
    const { engine, base } = await start();
    const queue = async () =>
      (await (await fetch(`${base}/treasury/review`, { method: "POST" })).json()) as {
        taskId: string;
        queued: number;
      };
    const first = await queue();
    const second = await queue();
    expect([first.queued, second.queued]).toEqual([1, 2]);
    expect(first.taskId).not.toBe(second.taskId);
    const { tasks } = (await (await fetch(`${base}/tasks?role=treasury`)).json()) as {
      tasks: { taskId: string; kind: string }[];
    };
    expect(tasks.map((t) => [t.taskId, t.kind])).toEqual([
      [first.taskId, "spend_review"],
      [second.taskId, "spend_review"],
    ]);
    expect(engine.controller.ledger.all()).toEqual([]);
  });

  it("after the price rise, the review names the new upstream price", async () => {
    const { engine, base } = await start();
    engine.world.upstream.setPrice(4);
    await fetch(`${base}/treasury/review`, { method: "POST" });
    const { tasks } = (await (await fetch(`${base}/tasks?role=treasury`)).json()) as {
      tasks: SpendReviewTask[];
    };
    expect(tasks[0]?.upstreamPrice).toEqual({ currency: "USDZ", cents: 4 });
  });
});
