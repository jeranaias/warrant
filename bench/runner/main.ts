import { appendFileSync, mkdirSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { ScriptedBrain, brainFromEnv } from "@warrant/agents";
import { deterministicPurpose, purposeFromEnv } from "@warrant/control";
import { loadCorpus } from "./case.js";
import { runBench } from "./run.js";
import { headline, summarize, table } from "./score.js";

/**
 * `pnpm bench`. Defaults need no key and make no model call: the naive scripted agent and the
 * deterministic purpose check. With ANTHROPIC_API_KEY set:
 *   BENCH_AGENT=model     the model agent (AGENT_MODEL, default Haiku)
 *   BENCH_PURPOSE=model   the model purpose check (PURPOSE_MODEL, default Haiku)
 *   BENCH_CONCURRENCY=8   cases at once (default 1; worth it with the model, which waits on
 *                         the network)
 * Writes bench/results/results.json and results.md (gitignored). With the defaults it also
 * rewrites bench/results.json, the committed headline the dashboard shows; CI fails when that
 * file differs from a fresh run.
 */
const corpusDir = fileURLToPath(new URL("../corpus", import.meta.url));
const headlineFile = fileURLToPath(new URL("../results.json", import.meta.url));
const outDir = fileURLToPath(new URL("../results", import.meta.url));
const env = process.env;

const cases = loadCorpus(corpusDir);
const brain = env["BENCH_AGENT"] === "model" ? brainFromEnv(env).brain : new ScriptedBrain();
const purpose = env["BENCH_PURPOSE"] === "model" ? purposeFromEnv(env) : deterministicPurpose;
console.log(`bench: ${cases.length} cases, agent ${brain.name}, purpose ${purpose.model}`);

const started = Date.now();
const concurrency = Number(env["BENCH_CONCURRENCY"] ?? 1);
if (!Number.isInteger(concurrency) || concurrency < 1 || concurrency > 32) {
  throw new Error("BENCH_CONCURRENCY must be a whole number from 1 to 32");
}
const results = await runBench(cases, { brain, purpose, concurrency });
const main = results.filter((r) => !r.heldout);
const heldout = results.filter((r) => r.heldout);
const scores = summarize(main);
let report = table(scores);
if (heldout.length > 0) report += "\n" + table(summarize(heldout), "Held-out set");
report += `\nagent: ${brain.name}; purpose: ${purpose.model}; ${cases.length} cases; ${Date.now() - started} ms\n`;

mkdirSync(outDir, { recursive: true });
writeFileSync(
  `${outDir}/results.json`,
  JSON.stringify(
    {
      at: new Date().toISOString(),
      agent: brain.name,
      purpose: purpose.model,
      scores,
      heldout: heldout.length > 0 ? summarize(heldout) : null,
      cases: results,
    },
    null,
    2,
  ) + "\n",
);
writeFileSync(`${outDir}/results.md`, report);
// Only the reproducible run (scripted agent, deterministic purpose check) is the published number.
if (brain instanceof ScriptedBrain && purpose === deterministicPurpose) {
  const held = cases.filter((c) => c.heldout).length;
  const h = headline(scores, { agent: brain.name, purpose: purpose.model, heldout: held });
  writeFileSync(headlineFile, JSON.stringify(h, null, 2) + "\n");
}
console.log(report);
if (env["GITHUB_STEP_SUMMARY"]) appendFileSync(env["GITHUB_STEP_SUMMARY"], report);
