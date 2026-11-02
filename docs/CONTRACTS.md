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
| `Payee`                | warrant.ts  | Allowlisted payee with routing ref, optional `billingPeriod`, card payees' `merchantCategoryCode`. No card numbers.        |
| `PaymentProposal`      | proposal.ts | The only thing an agent can submit. Carries an idempotency key.                                                            |
| `BudgetChangeProposal` | proposal.ts | Treasury's request to change a warrant's limits. Always owner-approved.                                                    |
| `PaymentSummary`       | summary.ts  | Everything the purpose model sees besides the warrant. Strict, no free text from untrusted sources.                        |
| `RulesResult`          | results.ts  | One `RuleCheck` per rule; `pass` only if all pass.                                                                         |
| `PurposeVerdict`       | results.ts  | `consistent` / `inconsistent` / `uncertain` + reason codes.                                                                |
| `ControlDecision`      | results.ts  | `execute` / `needs_owner_approval` / `blocked`.                                                                            |
| `OwnerApproval`        | approval.ts | Approve/deny bound to `shownHash` of what was displayed.                                                                   |
| `KillSwitchEvent`      | approval.ts | Revoked warrants, frozen cards, released reservations.                                                                     |
| `MandateRef`           | warrant.ts  | The Metal mandate a `metal_x402` warrant sits on: ids + mirrored cap/budget/expiry. Never a key or path (ADR-009).         |
| `SignedOrderRecord`    | orders.ts   | One sale: signed offer, tx hash, payer, price, sha256 of what we delivered. Written once (ADR-010).                        |
| `DisputeCase`          | orders.ts   | A customer's dispute over orders. Ticket text stays behind `ticketRef`.                                                    |
| `RefundDecision`       | orders.ts   | Per-order outcome with a reason code, decided in code from stored orders.                                                  |
| `WarrantGrant`         | pass.ts     | Owner-signed public part of a warrant a seller may see: payer, categories, cap, delegated key. No budgets (ADR-012).       |
| `WarrantPass`          | pass.ts     | Grant + one purchase signed by the delegated key, sent as `x-warrant-pass` on the paid request (ADR-012).                  |
| `AgentTask`            | tasks.ts    | One piece of work for an agent: `data_offer`, `dispute`, `invoice`, `sweep`, `spend_review`. `content` is untrusted text.  |
| `AgentSpend`           | tasks.ts    | One agent's cap, budget and spend, as control reports it in a `spend_review` task.                                         |
| `LedgerEntry`          | ledger.ts   | Append-only, hash-chained. reserve / confirm / release / unconfirmed / inbound / kill_switch.                              |

## Decided (2026-10-23)

- Warrant signing: ed25519 over the RFC 8785 (JCS) canonical JSON of `WarrantBody`. See ADR-005.
- Duplicate-guard window: same payee + same amount within **10 minutes** is a duplicate, in
  addition to any repeat `idempotencyKey`. See ADR-006.
- Always needs owner approval: see ADR-007.

## Decided (2026-10-29)

- `contractor_invoice` category replaced by `licence_fee` (Kit 11 brief).
- Refunds: `PaymentProposal.refundOfOrderId` names a stored order; control routes the refund to
  that order's payer and caps it at its price (rule `refund_matches_order`). The agent never names
  the refund address.
- Warrants on `metal_x402` carry a `MandateRef`; control refuses a warrant whose limits exceed its
  mandate (ADR-009).

## Decided (2026-10-30)

- Warrant pass (ADR-012): `WarrantGrant` and `WarrantPass` are signed with ed25519 over JCS like
  the warrant. `SignedOrderRecord.buyerPass` keeps the pass the buyer sent, as received.

## Decided (2026-11-02)

- Treasury gets two more task kinds (#26). `sweep`: earnings `available` in our Metal account,
  moved by one `treasury_sweep` proposal to our own Metal address on the warrant, then deposited
  to Airwallex by rails (ADR-010 item 4). `spend_review`: each agent's cap, budget and spend
  (`AgentSpend`) plus the 20 USDZ `totalLimit`, answered with `BudgetChangeProposal`s that always
  wait for the owner (ADR-007). The numbers come from control and the ledger, never from `content`.
- A recurring payee carries its period (#87): `Payee.billingPeriod` (`day`, `week`, `month`),
  optional and signed with the warrant. The licensor is `month`. Control makes a second payment to
  that payee inside one period wait for the owner; the period lengths are control constants.
- A card payee carries its merchant category code (#19): `Payee.merchantCategoryCode`, four
  digits, optional and signed with the warrant (the design tool seat is `5734`). The Airwallex card
  adapter copies the codes into the card's `allowed_merchant_categories`, so the card network
  refuses any other merchant type too.
