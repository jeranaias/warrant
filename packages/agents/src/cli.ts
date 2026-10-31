import { brainFromEnv } from "./brains.js";
import { EngineClient, runLoop } from "./runner.js";
import { counterIds } from "./tool.js";

/**
 * `pnpm agents`: run all three agents against a running engine (`pnpm engine`) until every queue
 * is empty, and print what control decided for each proposal.
 */
const base = process.env["ENGINE_URL"] ?? "http://127.0.0.1:4000";
const { brain, done } = brainFromEnv();
console.log(`agents (${brain.name}) -> ${base}`);
const runs = await runLoop({
  engine: new EngineClient(base),
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
  },
});
done();
console.log(`done: ${runs.length} task(s)`);
