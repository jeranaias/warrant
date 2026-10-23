# packages/agents

**Purpose:** the three agents (sourcing, support, treasury). Each has a `prompt.md` and a typed
`tools.ts`. The only money tool is `submitProposal(PaymentProposal)`; treasury can also submit a
`BudgetChangeProposal`.

**May import:** `@warrant/contracts`, a model SDK.

**Must never:**

- Import `@warrant/rails`, `@warrant/control` internals or `@warrant/mocks` (ESLint blocks it).
- Hold API keys for Airwallex or Metal, or see card numbers.
- Put amounts, limits, payee lists or validation rules in prompts. Those are enforced in
  `packages/control` from the signed warrant. A prompt limit is not a control.
- Pass raw upstream text into a proposal field other than `justification`.
