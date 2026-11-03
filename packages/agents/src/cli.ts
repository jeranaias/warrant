import { parseArgs } from "node:util";
import { brainFromEnv } from "./brains.js";
import { EngineClient, runLoop } from "./runner.js";
import { counterIds } from "./tool.js";

/**
 * `pnpm agents`: run all three agents against a running engine (`pnpm engine`) until every queue
 * is empty, and print what control decided for each proposal.
 *
 * `pnpm agents --scenario <name>` first loads that scenario into the engine's queue
 * (`POST /scenario`; names from `GET /scenarios`), replacing whatever was queued.
 */
const { values } = parseArgs({
  options: { scenario: { type: "string", short: "s" } },
  allowPositionals: false,
});
const base = process.env["ENGINE_URL"] ?? "http://127.0.0.1:4000";
const engine = new EngineClient(base);
if (values.scenario !== undefined) {
  const known = await engine.scenarios();
  if (!known.includes(values.scenario)) {
    console.error(`unknown scenario ${values.scenario}; one of: ${known.join(", ")}`);
    process.exit(2);
  }
  const queued = await engine.loadScenario(values.scenario);
  console.log(`scenario ${values.scenario}: ${queued} task(s) queued`);
}
const { brain, done } = brainFromEnv();
console.log(`agents (${brain.name}) -> ${base}`);
const runs = await runLoop({
  engine,
  brain,
  ids: counterIds(Date.now().toString(36)),
  onRun: (r) => {
    const lines = r.proposals.map(
      (p) =>
        `  ${p.proposal ? `${p.proposal.amount.cents} ${p.proposal.amount.currency} -> ${p.proposal.payeeId}` : "(malformed)"}: ${p.outcome.status}${p.outcome.blockedBy ? ` (${p.outcome.blockedBy})` : ""}`,
    );
    console.log(
      `${r.role} ${r.taskId}: ${r.proposals.length} proposal(s)${r.error ? ` error: ${r.error}` : ""}`,
    );
    for (const l of lines) console.log(l);
    for (const c of r.limitChanges) {
      const what = c.change
        ? `limits for ${c.change.warrantId}: total ${c.change.newTotalBudget.cents} ${c.change.newTotalBudget.currency}${c.change.newPerPaymentCap ? `, per payment ${c.change.newPerPaymentCap.cents} ${c.change.newPerPaymentCap.currency}` : ""}`
        : "(malformed limits)";
      console.log(
        `  ${what}: ${c.outcome.status}${c.outcome.detail ? ` (${c.outcome.detail})` : ""}`,
      );
    }
  },
});
done();
console.log(`done: ${runs.length} task(s)`);
