# Contracts

Source of truth: `packages/contracts/src`. This file explains intent. If they disagree, the code
wins and this file gets fixed in the same PR.

Changing contracts: PR labeled `contracts`, separate from feature work, one teammate's review.

| Type                   | File        | What it is                                                                                                                 |
| ---------------------- | ----------- | -------------------------------------------------------------------------------------------------------------------------- |
| `Money`                | common.ts   | `{ currency, cents }`, integer cents. The only money type inside the system.                                               |
| `Rail`                 | common.ts   | `metal_x402`, `airwallex_transfer`, `airwallex_fx`, `airwallex_card`.                                                      |
| `AgentRole`            | common.ts   | `sourcing`, `support`, `treasury`.                                                                                         |
| `Warrant`              | warrant.ts  | Owner-signed grant to one agent: purpose, rails, payees, per-payment cap, total budget, validity window. Limits inclusive. |
| `Payee`                | warrant.ts  | Allowlisted payee with rail routing ref. No card numbers.                                                                  |
| `PaymentProposal`      | proposal.ts | The only thing an agent can submit. Carries an idempotency key.                                                            |
| `BudgetChangeProposal` | proposal.ts | Treasury's request to change a warrant's limits. Always owner-approved.                                                    |
| `PaymentSummary`       | summary.ts  | Everything the purpose model sees besides the warrant. Strict, no free text from untrusted sources.                        |
| `RulesResult`          | results.ts  | One `RuleCheck` per rule; `pass` only if all pass.                                                                         |
| `PurposeVerdict`       | results.ts  | `consistent` / `inconsistent` / `uncertain` + reason codes.                                                                |
| `ControlDecision`      | results.ts  | `execute` / `needs_owner_approval` / `blocked`.                                                                            |
| `OwnerApproval`        | approval.ts | Approve/deny bound to `shownHash` of what was displayed.                                                                   |
| `KillSwitchEvent`      | approval.ts | Revoked warrants, frozen cards, released reservations.                                                                     |
| `LedgerEntry`          | ledger.ts   | Append-only, hash-chained. reserve / confirm / release / unconfirmed / inbound / kill_switch.                              |

## Open questions (decide before Oct 29)

- Warrant signing: ed25519 over canonical JSON. Which canonicalization (RFC 8785 JCS)?
- Duplicate-guard window for "same payee + same amount" (proposed: 10 minutes).
- Which categories always require owner approval.
