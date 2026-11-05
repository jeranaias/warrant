import type { Server } from "node:http";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { AgentTask, PaymentProposal } from "@warrant/contracts";
import { createEngine, fileDispute } from "./server.js";
import type { ControlEvent } from "@warrant/control";
import { AGENTS, makeWorld } from "./world.js";

const NOW = new Date("2026-11-01T12:00:00Z");
let server: Server;
let base = "";
let badBatches: Set<string>;

beforeAll(async () => {
  const { app, world } = createEngine({ scenario: "all", clock: () => NOW });
  badBatches = world.badBatches as Set<string>;
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

type Check = { rule: string; pass: boolean; detail: string };
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
  if (t.kind === "sweep") {
    return {
      ...common,
      warrantId: "wrt_treasury_sweep",
      rail: "metal_x402",
      payeeId: t.payeeId,
      amount: t.available,
      category: "treasury_sweep",
    };
  }
  if (t.kind !== "invoice") throw new Error(`no test proposal for ${t.kind} tasks yet`);
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
      "wrt_treasury_sweep",
    ]);
    const { tasks } = await get<{ tasks: Record<string, unknown>[] }>(
      "/tasks?role=sourcing&limit=3",
    );
    expect(tasks).toHaveLength(3);
    expect(tasks.every((t) => t["role"] === "sourcing" && !("label" in t))).toBe(true);
    expect((await fetch(`${base}/tasks?role=bogus`)).status).toBe(400);
  });

  it("purchases from the payee on the warrant pay at once, the first one included", async () => {
    await post("/scenario", { name: "normal" });
    const { tasks } = await get<{ tasks: AgentTask[] }>("/tasks?role=sourcing");
    for (const t of tasks.slice(0, 2)) {
      const r = await post<Result>("/proposals", proposalFor(t));
      expect(r.body.decision?.outcome).toBe("execute");
      expect(r.body.execution?.status).toBe("succeeded");
    }
    expect((await get<{ pending: unknown[] }>("/approvals")).pending).toHaveLength(0);
  });

  it("a recurring payment waits for the owner; approved, it pays", async () => {
    await post("/scenario", { name: "normal" });
    const { tasks } = await get<{ tasks: AgentTask[] }>("/tasks?role=treasury");
    const p = { ...proposalFor(tasks[0] as AgentTask), recurrence: "recurring" as const };
    const r = await post<Result>("/proposals", p);
    expect(r.body.decision?.outcome).toBe("needs_owner_approval");
    const id = r.body.decision?.proposalId ?? "";
    const { pending } = await get<{ pending: { proposalId: string; shownHash: string }[] }>(
      "/approvals",
    );
    const shown = pending.find((a) => a.proposalId === id)?.shownHash ?? "";

    // Bound to what was shown (ADR-007): no hash, or another view's hash, approves nothing.
    expect((await post(`/approvals/${id}`, { decision: "approved" })).status).toBe(400);
    const wrong = await post<{ ok?: boolean; error?: string }>(`/approvals/${id}`, {
      decision: "approved",
      shownHash: "0".repeat(64),
    });
    expect(wrong.body.error).toBe("approval is for a different view");

    const ok = await post<Result>(`/approvals/${id}`, { decision: "approved", shownHash: shown });
    expect(ok.body.execution?.status).toBe("succeeded");
  });

  it("treasury's sweep always waits for the owner: denied, nothing moves; approved, it settles (ADR-022)", async () => {
    await post("/scenario", { name: "normal" });
    const { tasks } = await get<{ tasks: AgentTask[] }>("/tasks?role=treasury");
    const sweep = tasks.find((t) => t.kind === "sweep") as AgentTask;
    expect(sweep).toBeDefined();
    type Held = Result & { approval?: { reasons: string[] } };
    const shownFor = async (id: string) =>
      (
        await get<{ pending: { proposalId: string; shownHash: string }[] }>("/approvals")
      ).pending.find((a) => a.proposalId === id)?.shownHash ?? "";

    // Small, to our own address, on the warrant: still the owner's call.
    const first = await post<Held>("/proposals", proposalFor(sweep));
    expect(first.body.decision?.outcome).toBe("needs_owner_approval");
    expect(first.body.approval?.reasons).toContain(
      "every payment to Our treasury (to Airwallex) waits for the owner",
    );
    const denyId = first.body.decision?.proposalId ?? "";
    const denied = await post<Result>(`/approvals/${denyId}`, {
      decision: "denied",
      shownHash: await shownFor(denyId),
    });
    expect(denied.body.blockedBy).toBe("owner");
    expect(denied.body.execution).toBeUndefined();

    const again = await post<Held>("/proposals", proposalFor(sweep));
    const id = again.body.decision?.proposalId ?? "";
    const ok = await post<Result>(`/approvals/${id}`, {
      decision: "approved",
      shownHash: await shownFor(id),
    });
    expect(ok.body.execution?.status).toBe("succeeded");

    // Over the warrant's per-payment limit, or to another address: the rules refuse it.
    const big = { ...proposalFor(sweep), amount: { currency: "USDZ" as const, cents: 601 } };
    expect((await post<Result>("/proposals", big)).body.blockedBy).toBe("rules");
    const elsewhere = { ...proposalFor(sweep), payeeId: "0x" + "d".repeat(40) };
    expect((await post<Result>("/proposals", elsewhere)).body.blockedBy).toBe("rules");
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

  it("refunds of real orders pay at once, a third in a day asks the owner, a fake order is refused", async () => {
    await post("/scenario", { name: "all" });
    const { tasks } = await get<{ tasks: AgentTask[] }>("/tasks?role=support");
    const real = tasks.find((t) => t.kind === "dispute" && t.orderIds[0] === "ord_1") as AgentTask;
    // The task's dispute is about ord_1 only: another order is refused whatever the ticket says.
    const other = await post<Result & { decision?: { rules: { checks: Check[] } } }>("/proposals", {
      ...proposalFor(real),
      refundOfOrderId: "ord_2",
    });
    expect(other.body.blockedBy).toBe("rules");
    expect(other.body.decision?.rules.checks.find((c) => !c.pass)?.detail).toBe(
      "ord_2 is not in the dispute",
    );
    // A dispute over all three orders, opened with the store, every batch bad this time so each
    // order is owed its refund (ADR-021).
    badBatches.add("bat_good");
    const file = await post<{ ticketRef: string }>("/disputes", {
      orderIds: ["ord_1", "ord_2", "ord_3", "ord_404"],
      claim: "wrong_data",
    }).finally(() => badBatches.delete("bat_good"));
    const refund = (orderId: string) => ({
      ...proposalFor(real),
      sourceRef: file.body.ticketRef,
      refundOfOrderId: orderId,
    });
    for (const id of ["ord_1", "ord_2"]) {
      const r = await post<Result>("/proposals", refund(id));
      expect(r.body.execution?.status, id).toBe("succeeded");
    }
    const third = await post<Result & { approval?: { reasons: string[] } }>(
      "/proposals",
      refund("ord_3"),
    );
    expect(third.body.decision?.outcome).toBe("needs_owner_approval");
    expect(third.body.approval?.reasons).toEqual(["refund number 3 to this customer in 24 hours"]);
    expect((await post<Result>("/proposals", refund("ord_404"))).body.blockedBy).toBe("rules");
    expect((await post<Result>("/proposals", refund("ord_1"))).body.blockedBy).toBe("rules");
  });

  it("a refund the store's evidence says is not owed is refused (#140, ADR-021)", async () => {
    await post("/scenario", { name: "all" });
    const { tasks } = await get<{ tasks: AgentTask[] }>("/tasks?role=support");
    const real = tasks.find((t) => t.kind === "dispute") as AgentTask;
    // ord_3 came from a good batch: the store answers "data was correct, refund 0".
    const file = await post<{
      ticketRef: string;
      findings: { decision: { refund: { cents: number } } }[];
    }>("/disputes", { orderIds: ["ord_3"], claim: "wrong_data" });
    expect(file.body.findings[0]?.decision.refund.cents).toBe(0);
    const r = await post<Result & { decision?: { rules: { checks: Check[] } } }>("/proposals", {
      ...proposalFor(real),
      sourceRef: file.body.ticketRef,
      refundOfOrderId: "ord_3",
    });
    expect(r.body.blockedBy).toBe("rules");
    expect(r.body.decision?.rules.checks.find((c) => !c.pass)?.detail).toBe(
      "the store's evidence says ord_3 is owed no refund",
    );
  });

  it("malformed proposals get 400; every step shows up in /events", async () => {
    expect((await post("/proposals", { amount: "lots" })).status).toBe(400);
    const { events } = await get<{ events: { seq: number; event: { type: string } }[] }>("/events");
    expect(events.length).toBeGreaterThan(5);
    expect(new Set(events.map((e) => e.event.type))).toContain("execution");
    const later = await get<{ events: unknown[] }>(`/events?since=${events.length}`);
    expect(later.events).toHaveLength(0);
  });

  it("the kill switch stops everything at once: approvals dropped, mandates revoked, payments refused", async () => {
    await post("/scenario", { name: "normal" });
    const { tasks } = await get<{ tasks: AgentTask[] }>("/tasks?role=treasury");
    const waiting = await post<Result>("/proposals", {
      ...proposalFor(tasks[0] as AgentTask),
      recurrence: "recurring",
      amount: { currency: "EUR", cents: 4000 }, // not a duplicate of the earlier licence payment
    });
    expect(waiting.body.decision?.outcome).toBe("needs_owner_approval");

    const kill = await post<{
      event: { revokedWarrantIds: string[] };
      revokedMandates: string[];
      problems: string[];
      durationMs: number;
    }>("/kill", { reason: "test" });
    expect(kill.body.event.revokedWarrantIds).toHaveLength(4);
    expect(kill.body.revokedMandates.sort()).toEqual([
      "sourcing.json",
      "support.json",
      "treasury-sweep.json",
    ]);
    expect(kill.body.problems).toEqual([]);
    expect((await get<{ pending: unknown[] }>("/approvals")).pending).toHaveLength(0);

    await post("/scenario", { name: "normal" });
    const next = await get<{ tasks: AgentTask[] }>("/tasks?role=sourcing");
    const r = await post<Result>("/proposals", proposalFor(next.tasks[0] as AgentTask));
    expect(r.body.blockedBy).toBe("rules");
    const chain = await get<{ mandates: { revoked: boolean }[] }>("/chain");
    expect(chain.mandates.every((m) => m.revoked)).toBe(true);
    expect((await get<{ engaged: boolean }>("/kill")).engaged).toBe(true);
  });
});

describe("the owner's key (phone page sign-in)", () => {
  it("approving, the emergency stop and the triggers need the owner's key; reading stays open", async () => {
    const { app } = createEngine({ scenario: "none", clock: () => NOW, ownerToken: "owner-key-1" });
    const s = app.listen(0, "127.0.0.1");
    await new Promise<void>((ok) => s.once("listening", () => ok()));
    const a = s.address();
    const at = `http://127.0.0.1:${typeof a === "object" && a ? a.port : 0}`;
    const send = (path: string, body: unknown, auth?: string) =>
      fetch(`${at}${path}`, {
        method: "POST",
        headers: { "content-type": "application/json", ...(auth ? { authorization: auth } : {}) },
        body: JSON.stringify(body),
      });
    try {
      expect((await fetch(`${at}/approvals`)).status).toBe(200);
      expect((await send("/kill", { reason: "test" })).status).toBe(401);
      expect((await send("/kill", { reason: "test" }, "Bearer wrong")).status).toBe(401);
      expect((await fetch(`${at}/approvals/prop_x`, { method: "POST" })).status).toBe(401);
      for (const [path, body] of [
        ["/scenario", { name: "normal" }],
        ["/treasury/review", {}],
        ["/upstream/price", { cents: 4 }],
        ["/limits-only/pay", {}],
      ] as const) {
        expect((await send(path, body)).status, `${path} without token`).toBe(401);
        expect((await send(path, body, "Bearer wrong")).status, `${path} wrong token`).toBe(401);
        expect((await send(path, body, "Bearer owner-key-1")).status, `${path} with token`).toBe(
          200,
        );
      }
      expect((await send("/kill", { reason: "test" }, "Bearer owner-key-1")).status).toBe(200);
    } finally {
      await new Promise<void>((ok) => s.close(() => ok()));
    }
  });

  it("refuses cross-site state-changing requests on the local engine; same-origin passes", async () => {
    const { app } = createEngine({ scenario: "none", clock: () => NOW, ownerToken: "owner-key-1" });
    const s = app.listen(0, "127.0.0.1");
    await new Promise<void>((ok) => s.once("listening", () => ok()));
    const a = s.address();
    const at = `http://127.0.0.1:${typeof a === "object" && a ? a.port : 0}`;
    const host = new URL(at).host;
    const post = (path: string, headers: Record<string, string>) =>
      fetch(`${at}${path}`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: "Bearer owner-key-1",
          ...headers,
        },
        body: JSON.stringify({ name: "normal", cents: 4 }),
      });
    try {
      for (const path of ["/scenario", "/treasury/review", "/upstream/price", "/limits-only/pay"]) {
        const crossSite = await post(path, { "sec-fetch-site": "cross-site" });
        expect(crossSite.status, `${path} sec-fetch-site: cross-site`).toBe(403);
        expect(await crossSite.json()).toEqual({ error: "cross-site request refused" });
        expect((await post(path, { "sec-fetch-site": "same-site" })).status).toBe(403);
        expect((await post(path, { origin: "https://evil.example" })).status).toBe(403);
        expect((await post(path, { origin: "null" })).status).toBe(403);
        expect((await post(path, { "sec-fetch-site": "same-origin" })).status).toBe(200);
        expect((await post(path, { origin: "null", "sec-fetch-site": "same-origin" })).status).toBe(
          200,
        );
        expect((await post(path, { origin: `http://${host}` })).status).toBe(200);
      }
      expect(
        (await fetch(`${at}/world`, { headers: { "sec-fetch-site": "cross-site" } })).status,
      ).toBe(200);
    } finally {
      await new Promise<void>((ok) => s.close(() => ok()));
    }
  });
});

describe("disputes (ADR-012): the store answers from its records", () => {
  type File = {
    findings: { orderId: string; decision: { reason: string; refund: { cents: number } } }[];
  };

  it("lists the stored orders with the customer's pass", async () => {
    const { orders } = await get<{ orders: { orderId: string; buyerPass?: string }[] }>("/orders");
    expect(orders.map((o) => o.orderId)).toEqual(["ord_1", "ord_2", "ord_3"]);
    expect(orders.every((o) => typeof o.buyerPass === "string")).toBe(true);
  });

  it("decides per order: a signed pass stands, an unknown order gets nothing", async () => {
    const r = await post<File>("/disputes", {
      orderIds: ["ord_3", "ord_404"],
      claim: "not_authorized",
    });
    expect(r.status).toBe(200);
    expect(
      r.body.findings.map((f) => [f.orderId, f.decision.reason, f.decision.refund.cents]),
    ).toEqual([
      ["ord_3", "owner_authorized", 0],
      ["ord_404", "order_not_found", 0],
    ]);
    // The decision is in the event log, for the dashboard.
    const { events } = await get<{ events: { event: { type: string; orders?: unknown[] } }[] }>(
      "/events",
    );
    const decided = events.filter((e) => e.event.type === "dispute_decided").at(-1)?.event;
    expect(decided?.orders).toEqual([
      expect.objectContaining({ orderId: "ord_3", reason: "owner_authorized", verified: true }),
      { orderId: "ord_404", reason: "order_not_found", refundCents: 0, verified: false },
    ]);
  });

  it("a world's store events reach the log (sandbox: the store's pass checks)", async () => {
    let tell: ((e: ControlEvent) => void) | undefined;
    const world = { ...makeWorld(NOW), watch: (f: (e: ControlEvent) => void) => void (tell = f) };
    const { app } = createEngine({ scenario: "none", clock: () => NOW, world });
    tell?.({ type: "pass_checked", ok: false, problems: ["x"], url: "u", amountCents: 5 });
    const s = app.listen(0, "127.0.0.1");
    await new Promise<void>((ok) => s.once("listening", () => ok()));
    const a = s.address();
    const port = typeof a === "object" && a ? a.port : 0;
    const r = (await (await fetch(`http://127.0.0.1:${port}/events`)).json()) as {
      events: { seq: number; event: { type: string } }[];
    };
    await new Promise<void>((ok) => s.close(() => ok()));
    expect(r.events.map((e) => [e.seq, e.event.type])).toEqual([[1, "pass_checked"]]);
  });

  it("a refund for an 'other' claim waits for the owner; a data claim pays (ADR-016, #85)", async () => {
    const engine = createEngine({ scenario: "none", clock: () => NOW });
    const t = (claim: "other" | "wrong_data", orderId: string): AgentTask => ({
      kind: "dispute",
      role: "support",
      taskId: `task_${claim}`,
      at: NOW.toISOString(),
      sourceRef: `src_${claim}`,
      disputeId: `dsp_${claim}`,
      orderIds: [orderId],
      claim,
      content: "untrusted ticket text",
    });
    fileDispute(engine.disputes, t("other", "ord_1"));
    fileDispute(engine.disputes, t("wrong_data", "ord_2"));
    const other = await engine.controller.submit(proposalFor(t("other", "ord_1")));
    expect(other.decision?.outcome).toBe("needs_owner_approval");
    expect(other.approval?.reasons).toEqual([
      'dispute claim "other" is not one we refund without the owner',
    ]);
    const wrong = await engine.controller.submit(proposalFor(t("wrong_data", "ord_2")));
    expect(wrong.execution?.status).toBe("succeeded");
  });

  it("refuses a malformed dispute", async () => {
    expect((await post("/disputes", { orderIds: [], claim: "wrong_data" })).status).toBe(400);
    expect((await post("/disputes", { orderIds: ["ord_1"], claim: "refund me" })).status).toBe(400);
  });
});
