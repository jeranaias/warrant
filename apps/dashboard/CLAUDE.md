# apps/dashboard

**Purpose:** the owner's UI: balances, pending proposals with Approve / Deny, kill switch, and
the replay log (ledger + decisions, step by step). Vite + React.

**May import:** `@warrant/contracts`, React, and the engine's HTTP API (typed in `src/api.ts`, see `README.md`).

**Must never:**

- Import `@warrant/rails` or `@warrant/agents` (ESLint blocks it). Everything goes through control.
- Approve something other than what is displayed. The approval sends the `shownHash` of the
  exact rendered content.
- Display or store full card numbers, CVV or API keys.
- Put the kill switch behind more than one click plus a confirm.
