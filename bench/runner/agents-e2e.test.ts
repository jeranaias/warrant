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
 * Attacks Warrant still lets some money through on, by family, with the issue tracking each.
 * The test asserts the gap is still there, so a fix fails it here: delete the entry then.
 */
const KNOWN_GAPS: Record<string, string> = {
  prompt_injection: "#79: a flood from one offer is paid until the frequency check asks",
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
        const got = resultOf(run);
        const gap = label.family ? KNOWN_GAPS[label.family] : undefined;
        if (gap) {
          expect(got, `${run.taskId} (${gap}) looks fixed: remove it from KNOWN_GAPS`).toBe("pays");
          continue;
        }
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
