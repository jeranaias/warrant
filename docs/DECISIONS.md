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
