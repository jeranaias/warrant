# packages/agents

**Purpose:** the three agents (sourcing, support, treasury). Each is a system prompt
(`src/<role>/prompt.md`) plus ONE money tool, `propose_payment` (`src/tool.ts`, ADR-008). The
runner fills ids, warrant, agent, idempotency key and `sourceRef`, then submits the
`PaymentProposal` to control (`POST /proposals`). Treasury also has `propose_limits` (`src/limits.ts`,
ADR-020) for `spend_review` tasks: a `BudgetChangeProposal` sent to `POST /budget-changes`, which
moves no money and always waits for the owner. Treasury's `sweep` task is not wired yet.

**Layout:**

- `brain.ts`: the `Brain` interface. Whatever decides what to propose for a task.
- `model.ts`: `ModelBrain`, plain `@anthropic-ai/sdk` tool use (Haiku by default; no agent
  framework). System prompt marked for prompt caching.
- `scripted.ts`: `ScriptedBrain`, a deterministic and deliberately naive agent that follows
  instructions in the task content, so attacks land. Used in CI, tests and runs without a key.
- `replay.ts`: record / replay of model responses for tests (`AGENT_RECORD=<file>` records).
- `runner.ts`: `runTask` (one task, any `Submit`), `EngineClient` and `runLoop` (the live loop).
- `brains.ts`: `brainFromEnv`: the model when `ANTHROPIC_API_KEY` is set, else the script.

Run against the engine: `pnpm engine`, then `pnpm agents` (or `pnpm agents --scenario <name>` to
load one of `GET /scenarios` first). `bench/runner/agents-e2e.test.ts` runs every scenario this way
in CI and checks each task against the feed's label.

**May import:** `@warrant/contracts`, a model SDK, node built-ins.

**Must never:**

- Import `@warrant/rails`, `@warrant/control` internals or `@warrant/mocks` (ESLint blocks it).
- Hold API keys for Airwallex or Metal, or see card numbers. Never print or log the model key.
- Put amounts, limits or validation rules in prompts. Those are enforced in `packages/control`
  from the signed warrant. A prompt limit is not a control. (The task turn shows the warrant's
  payee names so the agent knows whom it serves; control still enforces the list.)
- Pass raw upstream text into a proposal field other than `justification`.
- Call the model API in tests. Tests use `ScriptedBrain` or replayed fixtures.
