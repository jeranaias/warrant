import type { Server } from "node:http";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { AgentTask, PaymentProposal } from "@warrant/contracts";
import { createEngine } from "./server.js";
import { AGENTS } from "./world.js";

const NOW = new Date("2026-11-01T12:00:00Z");
let server: Server;
let base = "";

beforeAll(async () => {
  const { app } = createEngine({ scenario: "all", clock: () => NOW });
  server = app.listen(0, "127.0.0.1");
  await new Promise<void>((ok) => server.once("listening", () => ok()));
  const a = server.address();
  base = `http://127.0.0.1:${typeof a === "object" && a ? a.port : 0}`;
});
afterAll(() => new Promise<void>((ok) => server.close(() => ok())));

const get = async <T>(path: string) => (await (await fetch(base + path)).json()) as T;
const post = async <T>(path: string, body: unknown) => {
  const r = await fetch(base + path, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  return { status: r.status, body: (await r.json()) as T };
};

type Result = {
  decision?: { outcome: string; proposalId: string };
  blockedBy?: string;
  execution?: { status: string };
};

let n = 0;
/** What a well-behaved agent would propose for a task. */
function proposalFor(t: AgentTask): PaymentProposal {
  const who = AGENTS[t.role];
  const common = {
    proposalId: `prop_${++n}`,
    warrantId: who.warrantId,
    agentId: who.agentId,
    agentRole: t.role,
    idempotencyKey: `idem-${n}-xxxxxxxx`,
    sourceRef: t.sourceRef,
    justification: "test",
    createdAt: NOW.toISOString(),
    recurrence: "one_off" as const,
  };
  if (t.kind === "data_offer") {
    return {
      ...common,
      rail: "metal_x402",
      payeeId: t.payeeId,
      amount: t.price,
      category: "data_purchase",
    };
  }
  if (t.kind === "dispute") {
    return {
      ...common,
      rail: "metal_x402",
      payeeId: "customer",
      amount: { currency: "USDZ", cents: 5 },
      category: "customer_refund",
      refundOfOrderId: t.orderIds[0],
    };
  }
  return {
    ...common,
    rail: "airwallex_transfer",
    payeeId: t.payeeId,
    amount: t.amount,
    category: "licence_fee",
    recurrence: t.recurrence,
  };
}

describe("engine: tasks in, decisions out", () => {
  it("serves the world and tasks per role, without labels", async () => {
    const w = await get<{ warrants: { warrantId: string }[] }>("/world");
    expect(w.warrants.map((x) => x.warrantId)).toEqual([
      "wrt_sourcing",
      "wrt_support",
      "wrt_treasury",
    ]);
    const { tasks } = await get<{ tasks: Record<string, unknown>[] }>(
      "/tasks?role=sourcing&limit=3",
    );
    expect(tasks).toHaveLength(3);
    expect(tasks.every((t) => t["role"] === "sourcing" && !("label" in t))).toBe(true);
    expect((await fetch(`${base}/tasks?role=bogus`)).status).toBe(400);
  });

  it("first purchase waits for the owner; approved, it pays; the next pays at once", async () => {
    await post("/scenario", { name: "normal" });
    const { tasks } = await get<{ tasks: AgentTask[] }>("/tasks?role=sourcing");
    const first = await post<Result>("/proposals", proposalFor(tasks[0] as AgentTask));
    expect(first.body.decision?.outcome).toBe("needs_owner_approval");

    const pending = await get<{ pending: { proposalId: string }[] }>("/approvals");
    expect(pending.pending).toHaveLength(1);
    const ok = await post<Result>(`/approvals/${first.body.decision?.proposalId}`, {
      decision: "approved",
    });
    expect(ok.body.execution?.status).toBe("succeeded");

    const second = await post<Result>("/proposals", proposalFor(tasks[1] as AgentTask));
    expect(second.body.decision?.outcome).toBe("execute");
    expect(second.body.execution?.status).toBe("succeeded");
  });

  it("price rise, payee swap and a fake vendor are refused by the rules", async () => {
    await post("/scenario", { name: "all" });
    const { tasks } = await get<{ tasks: AgentTask[] }>("/tasks?limit=100");
    const labels = await get<{ labels: { taskId: string; label: { family?: string } }[] }>(
      "/labels",
    );
    const family = (t: AgentTask) => labels.labels.find((l) => l.taskId === t.taskId)?.label.family;
    for (const f of ["price_rise", "payee_swap", "fake_invoice"]) {
      const t = tasks.find((x) => family(x) === f) as AgentTask;
      const r = await post<Result>("/proposals", proposalFor(t));
      expect(r.body.blockedBy, f).toBe("rules");
    }
  });

  it("a refund for an order that doesn't exist is refused; a real one goes to the owner", async () => {
    await post("/scenario", { name: "all" });
    const { tasks } = await get<{ tasks: AgentTask[] }>("/tasks?role=support");
    const real = tasks.find((t) => t.kind === "dispute" && t.orderIds[0] === "ord_1") as AgentTask;
    expect((await post<Result>("/proposals", proposalFor(real))).body.decision?.outcome).toBe(
      "needs_owner_approval",
    );
    const fake = proposalFor(real);
    fake.refundOfOrderId = "ord_404";
    expect((await post<Result>("/proposals", fake)).body.blockedBy).toBe("rules");
  });

  it("malformed proposals get 400; every step shows up in /events", async () => {
    expect((await post("/proposals", { amount: "lots" })).status).toBe(400);
    const { events } = await get<{ events: { seq: number; event: { type: string } }[] }>("/events");
    expect(events.length).toBeGreaterThan(5);
    expect(new Set(events.map((e) => e.event.type))).toContain("execution");
    const later = await get<{ events: unknown[] }>(`/events?since=${events.length}`);
    expect(later.events).toHaveLength(0);
  });
});
