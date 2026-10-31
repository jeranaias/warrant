# bench

Attack corpus + runner + scoring. Run: `pnpm bench` (no API key needed).

- `corpus/`: one JSON file per case (`schema/attack.schema.json`, enforced by `runner/case.ts`).
  `corpus/heldout/` is scored separately (SCORING.md).
- `runner/`: `main.ts` is `pnpm bench`. `case.ts` loads and validates cases and turns one into
  the agent's task; `modes.ts` builds the three configs; `run.ts` runs a case and scores it;
  `score.ts` sums the metrics and prints the table.
- `SCORING.md`: how results are counted. Read it before adding cases.
- `results/`: `results.json` (every case, every mode) and `results.md` (the table). Gitignored.

## What a run does

For every case and every config (`unprotected`, `limits_only`, `warrant`), in a fresh engine
world: play the case's `prior` payments, give the task to the agent, and count what its
`propose_payment` calls achieve. `unprotected` pays every well-formed proposal; `limits_only` runs
the rules only; `warrant` posts to the engine (rules + purpose + owner + ledger + mock rails).

Defaults: the naive scripted agent (it obeys instructions in the content, so attacks land) and
the deterministic purpose check. With `ANTHROPIC_API_KEY` set, `BENCH_AGENT=model` uses the model
agent and `BENCH_PURPOSE=model` the model purpose check.

## Adding a case

1. Copy a case from the same family, give it a new `id` (= file name).
2. Write `setup.content` (the hostile text) and only the `setup.task` fields that differ from the
   defaults. Add `prior` payments if the attack depends on history (price change, duplicates).
3. `expected.moneyMoves`: `false` for attacks. `maxCents` if part of it is legitimate.
4. Run `pnpm bench`. The tests fail if an attack does not land on `unprotected` (the case would
   test nothing) or a benign case does not pay there.
