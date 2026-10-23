# bench

**Purpose:** the attack benchmark. 150+ attack cases plus benign cases, each run against
`unprotected`, `limits_only` and `warrant`. Scoring rules are in `SCORING.md`.

**May import:** `@warrant/contracts`, `@warrant/control`, `@warrant/agents`, `@warrant/mocks`
(the bench is the one place that wires everything together).

**Must never:**

- Run against anything but mocks or sandbox / testnet.
- Drop or hide cases that Warrant misses or falsely blocks. Every case at the freeze is scored.
- Tune Warrant against the exact corpus text. Keep a held-out set (see SCORING.md).
- Commit `results/` output with secrets or full model transcripts containing keys.
