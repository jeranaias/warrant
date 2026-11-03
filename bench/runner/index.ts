/**
 * The attack benchmark (SCORING.md): every case in `corpus/` runs under `unprotected`,
 * `limits_only` and `warrant`, each in a fresh world, with the same agent. `pnpm bench` runs
 * `main.ts`; the pieces are exported for tests and for anyone building on them.
 */
export { BenchCase, FAMILIES, caseToTask, loadCorpus } from "./case.js";
export { MODES, START, startMode } from "./modes.js";
export type { ModeName, ModeRun } from "./modes.js";
export { attackCents, runBench, runCase } from "./run.js";
export type { CaseResult, RunOptions, Verdict } from "./run.js";
export { summarize, table } from "./score.js";
export type { ModeScore } from "./score.js";
