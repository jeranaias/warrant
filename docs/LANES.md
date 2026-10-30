# Team lanes

One lane each. Based on Max's lanes plan (2026-10-29), updated for the current Kit 11 brief.
Every payment crosses lanes in this order:

```
A agent proposes -> C rules check -> A purpose check -> C ledger reserves -> C Metal x402 | B Airwallex card / FX -> D dashboard shows it
```

| Lane | Name                    | Owner                | Packages                                                                    | Load                   |
| ---- | ----------------------- | -------------------- | --------------------------------------------------------------------------- | ---------------------- |
| A    | Agents & attacks        | Elisei (@truelumpen) | `packages/agents`, `packages/control/purpose`, `bench`                      | medium-high            |
| B    | Airwallex rails         | Max (@GoudyMT)       | `packages/rails/airwallex`, `packages/mocks/airwallex`                      | medium                 |
| C    | Core: Metal + ledger    | @jeranaias (lead)    | `packages/contracts`, `control/{rules,ledger}`, `rails/metal`, `apps/store` | highest, critical path |
| D    | Dashboard, demo & pitch | Eva                  | `apps/dashboard`, `docs/DEMO.md`, README, video                             | medium, peaks late     |
| R    | Reviewer                | @jeranaias           | approves every PR before merge                                              | all lanes              |

Labels on the board: `lane:A`, `lane:B`, `lane:C`, `lane:D`.

## What each lane owns and what "done" means

**A: Agents & attacks.** Three agent prompts + one `propose_payment` tool each (ADR-008); the
purpose checker (separate model call, never sees raw text); the attack corpus and runner.
Done: 150+ attacks run with one command (`pnpm bench`); block rate and false-block rate reported
for unprotected vs limits only vs Warrant. Also owns the 2c -> 4c upstream price rise and the
dispute ticket from the agent side.

**B: Airwallex rails.** Kit 2 virtual card whose limits mirror the warrant; card freeze (half the
kill switch); simulated deposit of Metal earnings (tx hash as reference); EUR licence fee via FX +
transfer; the Airwallex mock so nobody waits. Done: one approved + one declined card purchase with
the policy's reason; earnings deposited and the licence fee paid; freeze in one timed call. Lighter
early: also builds the Metal CLI mock for lane C.

**C: Core: Metal + ledger.** Contracts; rules check (payee, cap, budget, expiry, duplicates);
hash-chained ledger (reserve -> confirm / release / unconfirmed); warrant signing; Metal adapter
(pay, pull, mandate replace); `apps/store` (our seller route with signed orders); daily
integration. Done: one payment + one on-chain refusal on testnet; a refused payment releases its
reservation; a tampered warrant is rejected; signed orders stored and verified.

**D: Dashboard, demo & pitch.** Approval screen, balances, Approve button, kill switch; the demo
script; the video under 5 minutes; README setup steps; the live Demo Day version (Nov 19). Done: a
stranger follows the README and runs it; the demo runs end to end twice; backup footage recorded.
Build on mock data from day 1.

**R: Reviewer.** Jesse approves every PR before merge (same-day turnaround). For PRs opened from
his own account, his written "approved" plus an admin merge stands in for a GitHub approval.
Serge is an offline advisor only (organizer rule): may read and comment, never writes code, pushes
or builds; audits benchmark scoring and joins two rehearsals before Nov 10.

## Kit 11 beats and who carries them

| Beat (brief)                                      | Lead | With |
| ------------------------------------------------- | ---- | ---- |
| Accounts + mandates, incl. customer               | C    | B    |
| Upstream provider + signed-order route            | C    | D    |
| Sell queries, store signed orders                 | C    |      |
| Price 2c -> 4c, sourcing refused                  | A    | C    |
| Treasury proposes limits; owner replaces mandates | C    | D    |
| Disputed batch + refund decision                  | C    | A, B |
| Seller proves who authorized it (warrant pass)    | C    | A, D |
| Earnings to Airwallex, then EUR licence fee       | B    | C    |
| Kit 2 card: pass, decline, freeze                 | B    | D    |

## Schedule

| Dates          | Phase               | Goal                                                                                                               |
| -------------- | ------------------- | ------------------------------------------------------------------------------------------------------------------ |
| Oct 29 - Nov 2 | 1. Thin slice       | Contracts frozen day 1; mocks; one sale with its signed order stored; sourcing refused at 4c (mock + testnet)      |
| Nov 3 - Nov 7  | 2. Both rails       | Earnings -> Airwallex deposit -> EUR licence fee; dispute + refund; Kit 2 card; ledger across rails; purpose check |
| Nov 8 - Nov 10 | 3. Decision + bench | Treasury proposal -> mandate replace; dashboard; kill switch; 150+ attacks                                         |
| Nov 11         | 4. Freeze           | Bug fixes only; rehearse; record backup footage                                                                    |
| Nov 12         | 5. Ship             | Video under 5 minutes; submit early (deadline now Nov 15, 11:59 PM PST; ADR-012)                                   |

## Day-1 agreements (all lanes)

1. Payment proposal format: `packages/contracts` as merged. Changes only by a `contracts` PR.
2. Ledger API: `reserve`, `confirm`, `release`, `markUnconfirmed`, `resolve`.
3. Warrant format and how "signed" is checked: ADR-005 (RFC 8785 + ed25519).
4. Stack: TypeScript everywhere; Python only for benchmark charts (ADR-008).
5. Merge daily. Review turnaround: same day.
