# packages/control

**Purpose:** the only path by which money leaves. Modules:

- `rules/`: deterministic checks in code (payee list, per-payment cap, total budget, expiry,
  duplicate guard, rail allowed, currency). Pure functions.
- `purpose/`: builds the `PaymentSummary` and calls a separate model that sees ONLY the signed
  warrant + that summary.
- `ledger/`: append-only, hash-chained. Reserve, then confirm / release / unconfirmed.
- `approvals/`: owner approval bound to a hash of exactly what was shown.
- `killswitch/`: revoke all warrants, freeze cards, release open reservations.

**May import:** `@warrant/contracts`, `@warrant/rails` (the interface), node built-ins, a model SDK
for `purpose/` only.

**Must never:**

- Import `@warrant/agents`.
- Pass raw invoice / offer / ticket text, `sourceRef` content, or `proposal.justification` to the
  purpose model.
- Call a rail without a ledger reservation first.
- Treat a rail timeout as failure, or retry without a status check.
- Execute anything other than exactly what the owner approved (shownHash must match).
- Log keys or card data.
