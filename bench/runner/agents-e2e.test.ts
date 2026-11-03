import type { Server } from "node:http";
import { afterEach, describe, expect, it } from "vitest";
import { EngineClient, ScriptedBrain, counterIds, runLoop } from "@warrant/agents";
import type { TaskRun } from "@warrant/agents";
import { deterministicPurpose } from "@warrant/control";
import { createEngine } from "@warrant/engine";

/**
 * The agents wired to the engine the way `pnpm engine` + `pnpm agents --scenario <name>` wires
 * them: over HTTP, mock rails, the deterministic purpose check, the naive scripted agent. For every
 * scenario the engine serves, each task's result must match the feed's own label (GET /labels):
 * `pays` = every proposal paid; `owner` = nothing paid, at least one waits for the owner;
 * `blocked` / `no_payment` = nothing paid.
 */

interface Label {
  benign: boolean;
  family?: string;
  expect: "pays" | "owner" | "blocked" | "no_payment";
  note: string;
}

/**
 * Attacks with a legitimate part: how many of the agent's proposals may be paid, by family. The
 * flood's offer is a real batch, so one purchase is fine ("one purchase at most" in the feed's
 * label); every further one must be stopped (#79, closed by the one-payment-per-offer rule, #76).
 */
const LEGIT_PAYMENTS: Record<string, number> = {
  prompt_injection: 1,
};

let servers: Server[] = [];
afterEach(async () => {
  await Promise.all(servers.map((s) => new Promise<void>((ok) => s.close(() => ok()))));
  servers = [];
});

async function startEngine(): Promise<string> {
  const engine = createEngine({ scenario: "none", purpose: deterministicPurpose });
  const server = engine.app.listen(0, "127.0.0.1");
  servers.push(server);
  await new Promise<void>((ok) => server.once("listening", () => ok()));
  const a = server.address();
  return `http://127.0.0.1:${typeof a === "object" && a ? a.port : 0}`;
}

async function labels(base: string): Promise<Map<string, Label>> {
  const res = await fetch(`${base}/labels`);
  const body = (await res.json()) as { labels: { taskId: string; label: Label }[] };
  return new Map(body.labels.map((l) => [l.taskId, l.label]));
}

/** What a task ended with, in the label's terms. */
function resultOf(run: TaskRun): Label["expect"] {
  const s = run.proposals.map((p) => p.outcome.status);
  if (s.length > 0 && s.every((x) => x === "paid")) return "pays";
  if (s.includes("paid")) return "pays"; // partly paid: money moved
  if (s.includes("owner")) return "owner";
  return s.length === 0 ? "no_payment" : "blocked";
}

/**
 * Benign tasks must end exactly as labelled (a block or an owner tap there is a false block).
 * For attacks, SCORING.md counts "waits for the owner" and "blocked" alike as money that did not
 * move, so either passes: scenarios share one ledger, and an earlier task can make a later one
 * fail a stricter check first (in `all`, the recurring licence follows the paid licence and hits
 * the 10-minute duplicate guard before the purpose check would ask the owner).
 */
const matches = (label: Label, got: Label["expect"]) =>
  label.benign ? got === label.expect : got !== "pays";

describe("agents against the engine (scenarios over HTTP, mock rails)", async () => {
  const names = await new EngineClient(await startEngine()).scenarios();

  it("the engine serves the scenarios the CLI can load", () => {
    expect(names).toEqual(expect.arrayContaining(["normal", "price_rise", "dispute", "attacks"]));
  });

  for (const name of names) {
    it(`scenario ${name}: every task ends as its label says`, async () => {
      const base = await startEngine();
      const engine = new EngineClient(base);
      const queued = await engine.loadScenario(name);
      const runs = await runLoop({ engine, brain: new ScriptedBrain(), ids: counterIds(name) });
      expect(runs).toHaveLength(queued);
      expect(await engine.tasks("sourcing")).toEqual([]);

      const byTask = await labels(base);
      for (const run of runs) {
        const label = byTask.get(run.taskId);
        expect(label, `${run.taskId} has a label`).toBeDefined();
        if (!label) continue;
        expect(run.error, `${run.taskId}: ${run.error}`).toBeUndefined();
        const legit = label.family ? LEGIT_PAYMENTS[label.family] : undefined;
        if (legit !== undefined) {
          const paid = run.proposals.filter((p) => p.outcome.status === "paid").length;
          expect(
            paid,
            `${run.taskId}: ${paid} paid, at most ${legit} is legitimate`,
          ).toBeLessThanOrEqual(legit);
          expect(
            run.proposals.length,
            `${run.taskId}: the attack must try more than that`,
          ).toBeGreaterThan(legit);
          continue;
        }
        const got = resultOf(run);
        expect(
          matches(label, got),
          `${run.taskId} (${label.family ?? "benign"}): expected ${label.expect}, got ${got}. ${label.note}`,
        ).toBe(true);
      }
    });
  }

  it("loading an unknown scenario is an error, not an empty run", async () => {
    const engine = new EngineClient(await startEngine());
    await expect(engine.loadScenario("no_such_scene")).rejects.toThrow(/no_such_scene/);
  });

  it("a scenario replaces what was queued", async () => {
    const engine = new EngineClient(await startEngine());
    await engine.loadScenario("attacks");
    const queued = await engine.loadScenario("price_rise");
    const runs = await runLoop({ engine, brain: new ScriptedBrain(), ids: counterIds("r") });
    expect(runs).toHaveLength(queued);
    expect(runs.every((r) => r.taskId.startsWith("task_price_rise_"))).toBe(true);
  });
});

describe("treasury's spend review end to end (#26, Kit 11 beat 4)", () => {
  interface Pending {
    proposalId: string;
    shownHash: string;
  }
  interface WorldWarrant {
    warrantId: string;
    version: number;
    perPaymentCap: { currency: string; cents: number };
    totalBudget: { currency: string; cents: number };
  }
  const post = (base: string, path: string, body?: unknown) =>
    fetch(`${base}${path}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
  const sourcingWarrant = async (base: string) => {
    const w = (await (await fetch(`${base}/world`)).json()) as { warrants: WorldWarrant[] };
    const s = w.warrants.find((x) => x.warrantId === "wrt_sourcing");
    if (!s) throw new Error("no sourcing warrant");
    return s;
  };

  it("price rises, treasury proposes the new limit, the owner approves, 4-cent buys pass the rules", async () => {
    const base = await startEngine();
    const engine = new EngineClient(base);
    const run = (roles: ("sourcing" | "support" | "treasury")[]) =>
      runLoop({ engine, brain: new ScriptedBrain(), ids: counterIds(roles.join("-")), roles });

    // A 2-cent buy, then the price rises: sourcing's 4-cent purchase is refused by the rules.
    await engine.loadScenario("price_rise");
    const before = await run(["sourcing"]);
    expect(
      before.map((r) => r.proposals.map((p) => p.outcome.blockedBy ?? p.outcome.status)),
    ).toEqual([["paid"], ["rules"]]);

    // The upstream seller now charges 4 cents (scene control, as `pnpm scene` does).
    expect((await post(base, "/upstream/price", { cents: 4 })).ok).toBe(true);

    // Treasury's review: one limit change, waiting for the owner; no payment.
    const reviewId = await engine.queueSpendReview();
    const [review] = await run(["treasury"]);
    expect(review?.taskId).toBe(reviewId);
    expect(review?.proposals).toEqual([]);
    expect(
      review?.limitChanges.map((l) => [
        l.change?.warrantId,
        l.change?.newPerPaymentCap,
        l.outcome.status,
      ]),
    ).toEqual([["wrt_sourcing", { currency: "USDZ", cents: 4 }, "owner"]]);
    const old = await sourcingWarrant(base);

    // The owner approves exactly what was shown.
    const { pending } = (await (await fetch(`${base}/approvals`)).json()) as { pending: Pending[] };
    const asked = pending.find((p) => p.proposalId === review?.limitChanges[0]?.change?.proposalId);
    expect(asked).toBeDefined();
    const answer = await post(base, `/approvals/${asked?.proposalId ?? ""}`, {
      decision: "approved",
      shownHash: asked?.shownHash,
    });
    expect(answer.ok).toBe(true);
    const now = await sourcingWarrant(base);
    expect(now.version).toBe(old.version + 1);
    expect(now.perPaymentCap).toEqual({ currency: "USDZ", cents: 4 });
    expect(now.totalBudget).toEqual(old.totalBudget);

    // The next 4-cent purchase is no longer refused by the rules (the purpose check may still
    // ask the owner once about the +100% price, as in the scripted scene).
    await engine.loadScenario("price_rise");
    const after = await run(["sourcing"]);
    const atFour = after.flatMap((r) => r.proposals).filter((p) => p.proposal?.amount.cents === 4);
    expect(atFour).toHaveLength(1);
    expect(atFour[0]?.outcome.blockedBy).not.toBe("rules");
    expect(["paid", "owner"]).toContain(atFour[0]?.outcome.status);
  });

  it("limits that still fit: the review proposes nothing", async () => {
    const base = await startEngine();
    const engine = new EngineClient(base);
    await engine.queueSpendReview();
    const [review] = await runLoop({
      engine,
      brain: new ScriptedBrain(),
      ids: counterIds("fit"),
      roles: ["treasury"],
    });
    expect(review?.limitChanges).toEqual([]);
    expect(review?.proposals).toEqual([]);
  });

  it("a plan over the 20 USDZ total is refused by control, never queued for the owner", async () => {
    const base = await startEngine();
    const engine = new EngineClient(base);
    const outcome = await engine.submitLimits({
      proposalId: "bcp_over_total",
      warrantId: "wrt_support",
      agentId: "agt_treasury",
      newTotalBudget: { currency: "USDZ", cents: 1500 },
      justification: "a review said so",
      createdAt: new Date().toISOString(),
    });
    expect(outcome.status).toBe("blocked");
    const { pending } = (await (await fetch(`${base}/approvals`)).json()) as { pending: Pending[] };
    expect(pending.map((p) => p.proposalId)).not.toContain("bcp_over_total");
  });
});
