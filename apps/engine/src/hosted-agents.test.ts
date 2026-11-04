import { describe, expect, it } from "vitest";
import { deterministicPurpose } from "@warrant/control";
import { hostedEngine, startAgents } from "./hosted-agents.js";
import { SessionStore } from "./hosted-sessions.js";
import { createEngine } from "./server.js";
import type { Engine } from "./server.js";

const makeEngine = (ownerToken: string) =>
  createEngine({ purpose: deterministicPurpose, ownerToken });

async function call(e: Engine, path: string, init: RequestInit = {}) {
  const server = e.app.listen(0, "127.0.0.1");
  await new Promise<void>((ok) => server.once("listening", () => ok()));
  const a = server.address();
  const port = typeof a === "object" && a ? a.port : 0;
  try {
    const r = await fetch(`http://127.0.0.1:${port}${path}`, {
      ...init,
      headers: { "content-type": "application/json", ...(init.headers ?? {}) },
    });
    return (await r.json()) as Record<string, unknown>;
  } finally {
    server.closeAllConnections();
    server.close();
  }
}

async function until(check: () => Promise<boolean>, ms = 10_000) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (await check()) return;
    await new Promise((ok) => setTimeout(ok, 20));
  }
  throw new Error("timed out");
}

const count = async (e: Engine, type: string) => {
  const { events } = (await call(e, "/events")) as { events: { event: { type: string } }[] };
  return events.filter((x) => x.event.type === type).length;
};
const decided = (e: Engine) => count(e, "proposal");

describe("hosted demo: the agents run inside the session", () => {
  it("a loaded scenario is worked through with no other process running", async () => {
    const e = makeEngine("owner-key");
    const agents = startAgents(e, { paceMs: 1, idleMs: 5 });
    try {
      const { queued } = await call(e, "/scenario", {
        method: "POST",
        body: JSON.stringify({ name: "all" }),
      });
      expect(queued).toBeGreaterThan(0);
      await until(async () => (await decided(e)) > 0);
      // Every queue drains: nothing is left for the agents.
      await until(async () => {
        const left = await Promise.all(
          ["sourcing", "support", "treasury"].map(async (r) => {
            const { tasks } = (await call(e, `/tasks?role=${r}&limit=1`)) as { tasks: unknown[] };
            return tasks.length;
          }),
        );
        return left.every((n) => n === 0);
      });
    } finally {
      agents.stop();
    }
  });

  it("STOP mid-run: everything after it is refused", async () => {
    const e = makeEngine("owner-key");
    const agents = startAgents(e, { paceMs: 30, idleMs: 5 });
    try {
      await call(e, "/scenario", { method: "POST", body: JSON.stringify({ name: "normal" }) });
      await until(async () => (await decided(e)) > 0);
      await call(e, "/kill", { method: "POST", headers: { authorization: "Bearer owner-key" } });
      // A payment already inside control when STOP landed may still finish: let it settle.
      await new Promise((ok) => setTimeout(ok, 100));
      const executedAtStop = await count(e, "execution");
      const proposedAtStop = await decided(e);
      await call(e, "/scenario", { method: "POST", body: JSON.stringify({ name: "normal" }) });
      await until(async () => (await decided(e)) > proposedAtStop);
      expect(await count(e, "execution")).toBe(executedAtStop);
    } finally {
      agents.stop();
    }
  });

  it("the session store starts agents per session and stops them on reset and close", () => {
    const started: string[] = [];
    const stopped: string[] = [];
    let n = 0;
    const store = new SessionStore({
      makeEngine,
      sweepMs: 0,
      startAgents: () => {
        const id = `a${++n}`;
        started.push(id);
        return { stop: () => stopped.push(id) };
      },
    });
    const s = store.create();
    if (!s) throw new Error("no session");
    store.reset(s);
    expect(started).toEqual(["a1", "a2"]);
    expect(stopped).toEqual(["a1"]);
    store.close();
    expect(stopped).toEqual(["a1", "a2"]);
  });

  it("a fresh visitor's engine is idle: nothing is paid until they load a scenario", async () => {
    const e = hostedEngine("owner-key");
    const agents = startAgents(e, { paceMs: 1, idleMs: 5 });
    try {
      await new Promise((ok) => setTimeout(ok, 200));
      expect(await decided(e)).toBe(0);
      await call(e, "/scenario", { method: "POST", body: JSON.stringify({ name: "normal" }) });
      await until(async () => (await decided(e)) > 0);
    } finally {
      agents.stop();
    }
  });

  it("the full run leaves the owner something to decide, through control's own rules", async () => {
    const e = hostedEngine("owner-key");
    const agents = startAgents(e, { paceMs: 1, idleMs: 5 });
    type Pending = { pending: { reasons: string[] }[] };
    try {
      await call(e, "/scenario", { method: "POST", body: JSON.stringify({ name: "all" }) });
      await until(async () => ((await call(e, "/approvals")) as Pending).pending.length > 0);
      const { pending } = (await call(e, "/approvals")) as Pending;
      expect(pending.flatMap((p) => p.reasons).join(" ")).toContain("already paid this month");
    } finally {
      agents.stop();
    }
  });
});

describe("agents inside the engine: treasury's spend review (#26)", () => {
  it("a review asked for from the dashboard is answered with a limit change for the owner", async () => {
    const e = createEngine({ purpose: deterministicPurpose, scenario: "none" });
    const driver = startAgents(e, { paceMs: 5, idleMs: 10 });
    try {
      e.world.upstream.setPrice(4);
      await call(e, "/treasury/review", { method: "POST" });
      type Pending = {
        pending: { view: { kind?: string; to?: { perPaymentCap?: { cents: number } } } }[];
      };
      await until(async () => ((await call(e, "/approvals")) as Pending).pending.length > 0);
      const { pending } = (await call(e, "/approvals")) as Pending;
      expect(pending.map((p) => [p.view.kind, p.view.to?.perPaymentCap?.cents])).toEqual([
        ["budget_change", 4],
      ]);
    } finally {
      driver.stop();
    }
  });

  it("a brain whose calls are used up takes no tasks: the queue is left alone", async () => {
    const e = createEngine({ purpose: deterministicPurpose, scenario: "none" });
    const driver = startAgents(e, { paceMs: 5, idleMs: 10, exhausted: () => true });
    try {
      const { queued } = (await call(e, "/scenario", {
        method: "POST",
        body: JSON.stringify({ name: "price_rise" }),
      })) as { queued: number };
      await new Promise((ok) => setTimeout(ok, 150));
      const health = (await call(e, "/health")) as { queued: number };
      expect(health.queued).toBe(queued);
    } finally {
      driver.stop();
    }
  });
});
