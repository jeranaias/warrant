import type { Server } from "node:http";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { AgentTask } from "@warrant/contracts";
import { createEngine } from "./server.js";
import { AGENTS } from "./world.js";

const NOW = new Date("2026-11-01T12:00:00Z");
let server: Server;
let base = "";

beforeAll(async () => {
  const { app } = createEngine({ scenario: "normal", clock: () => NOW });
  server = app.listen(0, "127.0.0.1");
  await new Promise<void>((ok) => server.once("listening", () => ok()));
  const a = server.address();
  base = `http://127.0.0.1:${typeof a === "object" && a ? a.port : 0}`;
});
afterAll(() => new Promise<void>((ok) => server.close(() => ok())));

async function propose(t: AgentTask, over: Record<string, unknown> = {}) {
  if (t.kind !== "data_offer") throw new Error("expected a data offer");
  const who = AGENTS.sourcing;
  const proposalId = `prop_replay_${Math.random().toString(36).slice(2, 10)}`;
  await fetch(base + "/proposals", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      proposalId,
      warrantId: who.warrantId,
      agentId: who.agentId,
      agentRole: "sourcing",
      rail: "metal_x402",
      payeeId: t.payeeId,
      amount: t.price,
      category: "data_purchase",
      recurrence: "one_off",
      idempotencyKey: `idem-${proposalId}`,
      sourceRef: t.sourceRef,
      justification: "test",
      createdAt: NOW.toISOString(),
      ...over,
    }),
  });
  return proposalId;
}

describe("GET /replay", () => {
  it("replays a paid purchase and a rule-blocked one, step by step", async () => {
    const { tasks } = (await (await fetch(base + "/tasks?role=sourcing&limit=1")).json()) as {
      tasks: AgentTask[];
    };
    const task = tasks[0];
    if (!task) throw new Error("no sourcing task");

    const paid = await propose(task);
    const r1 = (await (await fetch(`${base}/replay?proposalId=${paid}`)).json()) as {
      outcome: string;
      steps: { kind: string; entry?: string }[];
    };
    expect(r1.outcome).toBe("paid");
    expect(r1.steps.map((s) => s.kind)).toContain("rules");
    expect(r1.steps.at(-1)).toMatchObject({ kind: "ledger", entry: "confirm" });

    const blocked = await propose(task, { amount: { currency: "USDZ", cents: 9 } });
    const r2 = (await (await fetch(`${base}/replay?proposalId=${blocked}`)).json()) as {
      outcome: string;
      stoppedBy: string;
      steps: { kind: string; checks?: { rule: string; pass: boolean }[] }[];
    };
    expect(r2.outcome).toBe("blocked");
    expect(r2.stoppedBy).toBe("rules");
    const failed = r2.steps.find((s) => s.kind === "rules")?.checks?.filter((c) => !c.pass);
    expect(failed?.map((c) => c.rule)).toContain("per_payment_cap");
  });

  it("400 without an id, 404 for one nothing recorded", async () => {
    expect((await fetch(base + "/replay")).status).toBe(400);
    expect((await fetch(base + "/replay?proposalId=prop_unknown")).status).toBe(404);
  });
});
