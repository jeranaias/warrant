# Decisions (ADR log)

Append-only. New decision = new entry at the bottom. To reverse one, add a new entry that
supersedes it; don't edit the old one.

Template:

```
## ADR-NNN: <title>
Date: YYYY-MM-DD  Status: proposed | accepted | superseded by ADR-MMM
Context: what forced the decision
Decision: what we chose
Consequences: what this makes easy / hard
```

## ADR-001: TypeScript monorepo with pnpm workspaces

Date: 2026-10-23 Status: proposed

Context: Metal's SDK `@metalntwx/metal-pay` is an npm package; four people plus AI tools work in
parallel and need shared types.
Decision: pnpm workspaces, Node 24 LTS, strict TypeScript, zod schemas in `packages/contracts`,
ESLint + Prettier, Vitest. Packages export TypeScript source directly (no build step) until we
need one.
Consequences: one install, one CI job, type errors across packages show up immediately.

## ADR-002: Integer cents internally, convert only at the rail

Date: 2026-10-23 Status: proposed

Context: USDZ uses 18-decimal base units; Airwallex uses major units. Mixing them is how double
or 100x payments happen.
Decision: `Money { currency, cents }` everywhere inside the system. Conversion lives only in
`packages/rails`.
Consequences: rules and ledger never deal with decimals; rails own all unit tests for conversion.

## ADR-003: Purpose checker never sees untrusted text

Date: 2026-10-23 Status: proposed

Context: invoices and offers can carry hidden instructions.
Decision: the purpose model receives only the signed warrant and a strict `PaymentSummary` built
from structured fields.
Consequences: the purpose check can't be prompt-injected through upstream text; it also can't use
details that only exist in that text, which may raise `uncertain` verdicts.

## ADR-004: Package import boundaries enforced by ESLint

Date: 2026-10-23 Status: proposed

Decision: `no-restricted-imports` rules in `eslint.config.js` stop agents importing rails or
control, rails importing control or agents, and the dashboard importing rails or agents.

## ADR-005: Warrant signatures use RFC 8785 canonical JSON

Date: 2026-10-23 Status: accepted

Context: a signature over JSON only works if every signer and verifier serializes it the same way.
Decision: sign `WarrantBody` with ed25519 over its RFC 8785 (JSON Canonicalization Scheme)
serialization. The same canonicalization is used for `OwnerApproval.shownHash` and ledger hashes.
Consequences: one canonicalize function in control, used everywhere; field order never matters.

## ADR-006: Duplicate-payment guard window is 10 minutes

Date: 2026-10-23 Status: accepted

Decision: the `duplicate_guard` rule blocks (a) any repeat `idempotencyKey`, ever, and (b) the same
payee + same amount + same rail within 10 minutes (inclusive). It is a constant in
`packages/control/rules`, not a prompt or warrant field.
Consequences: a legitimate repeat purchase within 10 minutes needs a different amount or owner
approval. Revisit if the sourcing agent's pay-per-call pattern trips it; benign bench cases will
show that.

## ADR-007: What always needs owner approval

Date: 2026-10-23 Status: accepted

Decision: control returns `needs_owner_approval` (even when rules and purpose pass) for:

1. any `BudgetChangeProposal`;
2. the first payment to a payee (no prior confirmed payment in the ledger);
3. any `recurring` payment (subscription traps);
4. any `airwallex_transfer` or `airwallex_fx` of USD 100.00 (10000 cents) or more, inclusive;
5. any `uncertain` purpose verdict.
   Everything else that passes rules and gets `consistent` executes without asking.
   Consequences: the demo shows owner approval on treasury moves while x402 micro-payments stay
   automatic. The threshold is a code constant; changing it is a new ADR.

## ADR-008: Stay on TypeScript; the name is Warrant

Date: 2026-10-29 Status: accepted

Context: after the shortlist the team weighed a Python stack (FastAPI, Pydantic, SQLite) against
this TypeScript scaffold. Metal ships only npm packages. Kit 11 needs them on both sides: buying
and payouts (`@metalntwx/metal-agent`) and selling with signed orders (`@metalntwx/metal-pay`:
`requireSignedOffer`, `signedOfferOf`, `verifyMandatePayment`, `onAfterSettle`).
Decision: TypeScript everywhere (ADR-001 stands). Python is allowed only for benchmark charts in
`bench/`. From the Python review we keep: one `propose_payment` tool per agent, plain Anthropic
SDK (no LangGraph), Haiku for sourcing/support and the cheapest purpose model that holds the
block rate, Batch API for benchmark runs, record/replay of model responses in tests, prompt
caching for the system prompt + warrant. The project name is **Warrant** (not Warden).
Consequences: the money path (reserve -> pay -> confirm) is one language and one process; no
Python-to-Node bridge. Teammates who know Python better review TypeScript drafted with Claude.

## ADR-009: Kit 11 numbers are code constants; warrants sit on top of Metal mandates

Date: 2026-10-29 Status: accepted

Context: the Kit 11 brief fixes the numbers and says "prices, budgets and the licence fee stay in
code". Metal mandates enforce limits on chain; our warrants enforce rules + purpose off chain.
Decision:

1. `packages/control/src/business.ts` holds the constants: total 2000 cents USDZ; sourcing 1000
   (cap 3 cents per purchase), support 400, treasury 600; query price 5 cents; upstream price 2
   cents, rising to 4. The monthly licence fee is EUR 50.00 (our choice; the brief gives no
   amount).
2. Each agent has one warrant and one mandate with the same payees, cap, budget and expiry. A
   warrant's limits may never exceed its mandate's; control checks this when loading warrants.
3. Two layers, on purpose: our rules check refuses first (no model call, no chain call). The
   mandate is the backstop if our code is wrong or bypassed. The demo shows both: the 4-cent
   purchase refused by our rules, and the same purchase refused on chain as `mandate_cap_exceeded`
   when sent around control (benchmark "limits only" mode).
4. Treasury's limit change is a `BudgetChangeProposal` (always owner-approved, ADR-007). On
   approval the owner, not an agent, runs `mandate replace` (spend carries forward, so a new budget
   must exceed what is already spent) and signs the new warrant. Old credentials are then refused
   as `mandate_revoked`.
5. Agents never hold an owner key, a mandate key or a credential file. Only `packages/rails` reads
   them, from `METAL_HOME` outside the repo.
   Consequences: one table of numbers to change; the benchmark can show where each layer catches an
   attack.

## ADR-010: Metal integration: CLI for paying, metal-pay for selling, signed orders stored

Date: 2026-10-29 Status: accepted

Context: there is no Metal TypeScript client for paying under a mandate; the supported path is the
`metal-agent` CLI. Selling needs `@metalntwx/metal-pay` in an x402 Express server.
Decision:

1. **Paying (sourcing):** `packages/rails` runs `metal-agent pay <url> --mandate <cred>` with
   `execFile` (no shell) and parses its `key value` lines. "A payment was signed and may have
   settled" and `payment in doubt` map to `unknown` (ledger `unconfirmed`); `getStatus` looks the
   payment up by its printed `nonce` in the facilitator's `/settlements?payTo=` or with
   `mandate verify`. `payment refused: mandate_*` maps to `failed` with the reason code.
2. **Payouts (support refunds, treasury moving earnings):** `metal-agent mandate pull --payment-id
<idempotencyKey>`. A retry with the same id pays at most once, so `getStatus` is "run it
   again". Exit 3 (`pending`) = `pending`; exit 4 (`held`) = `pending`, never re-sent.
3. **Selling:** a new `apps/store` Express server (our data business) with `requireSignedOffer`
   and `SIGNED_OFFER_REQUIRED` on `GET /query`, one route per item so the signed order names it.
   `onAfterSettle` stores a `SignedOrderRecord` (order, settlement tx hash, sha256 of what we
   delivered) in an append-only file. Disputes use `verifyMandatePayment(tx, checkoutMandate)`.
4. **Moving earnings to Airwallex:** a payout to a Metal address we control, then
   `POST /api/v1/simulation/deposit/create` with the transaction hash as the reference (the sandbox
   cannot receive stablecoins).
5. Mocks (`packages/mocks`) imitate the same CLI output and HTTP shapes so lanes never wait on
   testnet.
   Consequences: the CLI version is pinned (0.3.3); its output format is our parser's contract, so
   the parser has fixture tests taken from real runs.

## ADR-011: Duplicate window does not apply to x402 purchases or refunds

Date: 2026-10-29 Status: accepted (amends ADR-006)

Context: ADR-006's "same payee + same amount + same rail within 10 minutes" rule would block the
sourcing agent's normal pattern (many 2-cent purchases from one upstream) and two legitimate
5-cent refunds to one customer.
Decision: a repeated `idempotencyKey` is still refused on every rail, forever. The 10-minute
payee + amount window applies only to Airwallex rails and not to refunds. x402 purchases are
bounded by the cap, the budget and the mandate; refunds are bounded per order by
`refund_matches_order` (one refund per order, at most its price).
Consequences: a looping sourcing agent can only burn its own budget (10 USDZ), which the
benchmark measures.

## ADR-012: Build toward what Metal asked for; the deadline moved to Nov 15

Date: 2026-10-30 Status: accepted

Context: on the hackathon Slack (#metal-kits-11-and-12, 2026-10-29) Metal said what they want to
see for the Metal Award: disputes and merchant purchase verification. What can a seller prove,
then decide, when an agent's purchase is questioned? For example, a customer insists their agent
never agreed to an order or a price, or a seller wants to know whether the agent is acting under a
mandate a real human signed, and the seller settles it on its own terms. Other facts from the
Slack: submissions are due **Sun Nov 15, 2026, 11:59 PM PST** (extended from Nov 13); current
packages are `metal-agent` 0.3.3 and `metal-pay` 0.3.4; pay-per-call clearing is live on testnet
in `metal-pay` (docs.metalntwx.com/agents/clearing). Other Kit 11 teams already use mandate caps,
replace and revoke, signed orders, pull refunds and a sweep to Airwallex, so those are table
stakes, not our edge.
Decision:

1. **Warrant pass (lane C).** A buying agent's request carries a pass signed by its owner's
   control, sent as the `x-warrant-pass` header (`metal-agent pay --header`). The owner signs a
   public grant once (payer, categories, per-payment cap, delegated key; never budgets or other
   payees); control signs a pass per purchase (seller, URL, amount, category, nonce, proposal
   hash). Sellers check both signatures and the fit to the grant before serving; a refusal
   happens before the x402 payment settles. Our store checks customers' passes; the upstream
   provider checks ours. Every stored order keeps the pass.
2. **The dispute is the lead Metal beat (C leads, A and D with).** A customer disputes a batch.
   The store answers from evidence alone: the signed order (item and price), the settlement
   transaction, `verifyMandatePayment`, and the customer's pass (a human-signed grant). It then
   decides on its own terms and refunds by `mandate pull` when the evidence says so.
3. **What only we show**, in the demo, the README and the video: owner approval bound to exactly
   what was shown (ADR-007); a purpose check that never sees agent text (ADR-003); the 150+
   attack scores across unprotected, limits only and Warrant; the kill switch timed end to end;
   the seller-side proof above.
4. Pay-per-call clearing is a stretch goal, only after Nov 10.
5. We still submit on **Nov 12**. Nov 13 to 15 is buffer for fixes, rehearsal and the video only.
   Consequences: the dispute beat moves earlier in the demo script; lane C adds the pass to
   `packages/control` and `apps/store`; lane A adds attacks that try to buy without a valid pass
   or with someone else's.

## ADR-013: Fewer owner taps: a signed payee is approved; ordinary refunds go through

Date: 2026-10-30 Status: accepted (amends ADR-007 item 2)

Context: ADR-007 asked the owner about the first payment to every payee and about every refund.
The owner already named each payee when signing the warrant, so the first-payment question asked
again about something decided. Refunds are already bounded by `refund_matches_order` (a stored
order, paid back to its own payer, at most its price, once). Too many questions is why people
switch safety checks off; the owner's taps per demo run is a number we show.
Decision:

1. ADR-007 item 2 is withdrawn: a payee on the signed warrant is paid without asking, first
   payment included. A payee that is not on the warrant is still refused by the rules.
2. A refund the rules accept goes through without the owner unless it looks unusual: more than
   `REFUND_WITHOUT_OWNER_MAX` (25 cents), or the third or later refund to the same customer
   within 24 hours (`REFUNDS_WITHOUT_OWNER_PER_DAY` = 2). Both are code constants in
   `business.ts`.
3. Items 1, 3, 4 and 5 of ADR-007 are unchanged: budget changes, recurring payments, Airwallex
   transfers or FX of 100.00 or more, and an `uncertain` purpose verdict always ask.
   Consequences: the normal demo run needs the owner only for the budget change and anything
   unusual. A later "always allow this" choice on the approval screen would turn a repeated
   approval into a new signed warrant version; it is not built yet.

## ADR-014: The duplicate window matches amounts within 1%

Date: 2026-11-02 Status: accepted (amends ADR-006)

Context: the bench found that EUR 49.99 eight minutes after EUR 50.00, same payee and rail,
passed the duplicate guard because it compared exact amounts (#86, `duplicate-charge-005`). A
re-issued invoice one cent off is the cheapest way round an exact match.
Decision: inside the 10-minute window, two payments to the same payee on the same rail are
duplicates when the amounts are within 1% of the larger one, inclusive
(`DUPLICATE_TOLERANCE_BPS` = 100 in `packages/control/rules`, integer math). A percentage, not a
fixed number of cents: a fixed few cents would make every small payment a "duplicate" of any other
and still let a large one through by moving it a few cents more. At 1%, amounts under 100 cents
only match exactly, so small repeat payments are unaffected. x402 purchases and refunds stay
outside the window (ADR-011), so the 2-cent repeat buys never meet this check.
Consequences: a legitimate second payment to the same Airwallex payee within 10 minutes needs an
amount more than 1% different or waits for the window to pass.

## ADR-015: A payee that bills once per period is paid once per period without asking

Date: 2026-11-02 Status: accepted (amends ADR-013 item 1)

Context: the licence is billed once a month, but nothing on the warrant said so. The bench found
that the same licence bill 45 minutes later, or a small "FX correction" top-up to the licensor,
passed every check (#87, `duplicate-charge-002`, `fx-rate-manipulation-005`). The 10-minute
duplicate window (ADR-006, ADR-014) is the wrong tool: it is minutes, and it matches amounts.
Decision:

1. A `Payee` on the signed warrant may carry `billingPeriod` (`day`, `week`, `month`). The engine's
   licensor is `month`.
2. Control pays such a payee once per period without asking. Another payment to it, of any amount
   and any category, within the period of the last one that was not released, waits for the owner
   (`needs_owner_approval`, reason "... bills once a month and was already paid this month").
   Rules still run first; this is an approval reason, not a block.
3. Period lengths are code constants (`BILLING_PERIOD_MS` in `business.ts`): a day is 24 hours, a
   week 7 days, a month 28 days. 28 is the shortest month, so next month's real invoice never
   waits; the cost is that a second bill on day 29 to 31 of a long month is not caught here.
   Consequences: a legitimate second payment to the licensor in one month (a mid-month seat, a real
   correction) costs the owner one tap. Payees without a period are unchanged.

## ADR-016: Refunds for a dispute claim outside the refundable set wait for the owner

Date: 2026-11-02 Status: accepted (amends ADR-013 item 2)

Context: refunds for a `claim: other` dispute (owner impersonation, a sympathy story) went through
on their own, because control never saw the claim (#85, `urgent-refund-social-002`, `-003`).
Decision: control reads the claim from the stored dispute the refund's `sourceRef` names (#84),
never from the ticket text. `REFUNDABLE_CLAIMS` in `business.ts` is `wrong_data`,
`not_delivered` and `not_authorized`: the claims the store has evidence rules for (ADR-012). A
refund for any other claim waits for the owner, whatever its amount. The other ADR-013 limits
(25 cents, two a day per customer) still apply on top.
Consequences: an `other` dispute costs the owner one tap per refund. The purpose checker still
does not see the claim (no `PaymentSummary` change).

## ADR-017: The sandbox pays the EUR licence by SWIFT

Date: 2026-11-02 Status: accepted

Context: the first live run of the earnings beat on the Airwallex sandbox (`pnpm scene:earnings
--sandbox`) found two gaps the mock hid. The simulated deposit needs a `global_account_id`: the
deposit lands in a Global Account, not a bare currency. A EUR `LOCAL` transfer is refused with
`fee_unknown` ("a problem with your transfer fee configuration"), with the fee paid by the payer or
by the beneficiary. A USD `LOCAL` (ACH) transfer and a EUR `SWIFT` transfer both go through on the
same account, so the account's fee setup covers SWIFT for EUR but not SEPA.
Decision:

1. `depositEarnings` takes an optional `globalAccountId`. The sandbox world finds the account's
   active USD Global Account (`globalAccountFor`). The mock still takes a bare currency.
2. `AirwallexTransfers` takes `transferMethod` (`LOCAL` by default, or `SWIFT` with
   `swift_charge_option: SHARED`). `createEurBeneficiary` takes an optional BIC; with one, the
   beneficiary is a SWIFT beneficiary. The sandbox world pays "Data Licensor GmbH (SWIFT)", a
   German IBAN with BIC COBADEFFXXX, found by nickname after the first run.
3. In the sandbox, treasury converts the whole fee from USD (`alwaysConvert`), even though the
   sandbox wallet already holds euros. Treasury pays EUR bills out of USD earnings, and the demo
   shows the conversion.
   Consequences: the sandbox run is deposit, conversion and a SWIFT transfer, then the sandbox
   moves it to PAID and control's ledger confirms it. If Airwallex enables EUR LOCAL fees on the
   account, switch `transferMethod` back to `LOCAL`; nothing else changes. Metal stays on the mock
   chain in this scene; `RAILS_MODE=sandbox pnpm scene` covers Metal live.

## ADR-018: The Kit 2 card carries the warrant's limits, and a purchase is never resent

Date: 2026-11-02 Status: proposed

Context: treasury pays a software seat on an Airwallex-issued virtual Visa card (rail
`airwallex_card`, #19). Control already refuses anything outside the warrant, but the card is a
real payment instrument with its own number: if anything ever spent on it around control, only the
card's own controls would stand in the way. The sandbox purchase is the simulator
(`POST /api/v1/simulation/issuing/create`), which takes no `request_id`, so a resend charges twice.
Decision:

1. The card's `authorization_controls` are set from the signed warrant: per-payment cap ->
   `PER_TRANSACTION` limit, total budget -> `ALL_TIME` limit, `active_to` = the warrant's expiry,
   `allowed_merchant_categories` = the card payees' `merchantCategoryCode`s (all of them, or none if
   a card payee has no code), `allowed_currencies` = the warrant's currency. A new card is created
   that way; an existing card (AIRWALLEX_CARD_ID, or the first ACTIVE one) is updated to match, and
   if the API refuses the update the scene prints "not mirrored" with what differs.
2. Each idempotency key is sent to the card at most once. A retry is answered from what the adapter
   already knows; after a timeout the outcome stays `unknown` until the transactions list shows it.
3. The kill switch calls `freezeAll()`: every card the adapter issued or adopted goes `INACTIVE`.
   A card that cannot be frozen is reported as a kill-switch problem; control has stopped all
   payments regardless.
4. The card number and CVV are never fetched (no `/details` call); every line the adapter returns
   or logs is also stripped of any 13 to 19 digit run.
   Consequences: `pnpm scene:card` shows the warrant enforced twice: control blocks the over-cap
   purchase, and the same purchase sent straight to the card is declined by the card's own limit
   (`LIMIT_EXCEEDED`); after STOP the card declines as `CARD_INACTIVE`. In the sandbox, STOP leaves
   the owner's card INACTIVE until it is unfrozen.
