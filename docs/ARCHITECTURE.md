# Architecture

## Rule

**Agents propose, control decides, money only leaves through control.**

```
 untrusted input            agents                   control                         rails
 (offers, invoices,   ->  sourcing  \                                           /-> metal_x402
  tickets, notices)       support    > PaymentProposal -> rules -> purpose  ->  ledger  -> airwallex_transfer
                          treasury  /                       |        |      reserve     -> airwallex_fx
                                                            v        v         |        -> airwallex_card
                                                         blocked  needs owner  v
                                                                  approval   confirm / release / unconfirmed
                                                                     |
                                                                 dashboard (owner)
                                                                 Approve / Deny / Kill switch
```

## Trust boundaries

| Component         | Sees                                                 | Never sees                             |
| ----------------- | ---------------------------------------------------- | -------------------------------------- |
| Agents            | untrusted upstream text, their own warrant's purpose | keys, card data, rails                 |
| Rules check       | warrant, proposal, ledger view                       | nothing model-generated is trusted     |
| Purpose model     | signed warrant + `PaymentSummary`                    | raw upstream text, agent justification |
| Rails             | approved + reserved `RailInstruction`                | agents                                 |
| Owner (dashboard) | proposal, summary, decision, ledger                  | card PAN/CVV, keys                     |

## Decision flow

1. Agent submits `PaymentProposal` (zod-validated; malformed = rejected).
2. `rules/` produces `RulesResult`. Any failure -> `blocked`. Purpose check is skipped.
3. `purpose/` builds `PaymentSummary` from structured fields and asks the purpose model for a
   `PurposeVerdict`. `inconsistent` -> `blocked`; `uncertain` -> `needs_owner_approval`.
4. Some categories always need the owner (budget changes, first payment to a payee, FX payout
   above a threshold; exact list is an ADR to write).
5. Owner approval is bound to `shownHash`. Execution recomputes the hash; mismatch -> ask again.
6. `ledger/` writes `reserve`, calls the rail with the idempotency key, then `confirm` or
   `release`. Timeout -> `unconfirmed` -> `getStatus()` -> resolve. Never retry blind.
7. Kill switch: revoke all warrants, freeze all cards, release open reservations, one
   `KillSwitchEvent` in the ledger.

## Units

Internal: integer cents. Metal/USDZ: 18-decimal base units (bigint). Airwallex: major units
(decimal string). Conversion only inside `packages/rails`.
