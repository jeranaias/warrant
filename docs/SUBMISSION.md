# Submission form: draft

Draft text for the hackathon submission form. Anything marked TODO is not verified yet. Check each
one before we submit (target Nov 12).

## Project name

Warrant

## One-line description

The owner signs a warrant for each AI agent, and every payment the agent asks for is checked
against it before any money moves.

## Description (~200 words)

Warrant lets a business run AI agents that spend money without handing them the keys. The owner
signs a warrant for each agent: who it may pay, how much per payment and in total, on which rails,
and until when. Agents never pay anyone. They send a typed payment proposal, and Warrant decides.
Rules in code check the payee, the cap, the budget, the expiry and repeats. A separate purpose
check sees only the signed warrant and a structured summary, never the invoice or offer text, so
hidden instructions in that text cannot reach it. Budget changes, recurring payments, large
Airwallex transfers and unclear cases wait for the owner on their phone. The approval is bound to
exactly what the owner saw. One STOP button refuses every payment from then on and revokes the
agents' mandates.

Our demo is the Kit 11 data business. Three agents (sourcing, support, treasury) buy upstream
data, settle disputes and pay a EUR licence fee, over x402 on Metal and through Airwallex. Each
warrant sits on a Metal mandate with the same limits, so the chain still enforces them if our
code is bypassed. Sellers can check a buyer's warrant pass, a grant its human owner signed, and settle
disputes from evidence. On our 79-case benchmark, Warrant blocks 54 of 60 attacks, against 42 for
mandate limits alone.

## The problem

AI agents can now pay for things. Most spending controls are a cap and a budget. A cap does not
stop an agent that was talked into paying a new address, paying the same invoice twice, or setting
up a subscription nobody asked for. A rule written in the agent's prompt is not a control: the
agent can be told to ignore it. And when a purchase is disputed, the seller has no way to prove
that the agent was acting for a real person who agreed to it.

## How it works

1. The owner signs a warrant per agent (payees, per-payment cap, total budget, rails, expiry). Each
   warrant matches a Metal mandate with the same limits.
2. An agent proposes a payment through its one tool, `propose_payment`. It never holds a key or a
   card number.
3. Control runs the rules in code. Any failure blocks the payment, with no model call.
4. The purpose check sees only the warrant and a structured payment summary.
5. Some payments always ask the owner: budget changes, recurring payments, Airwallex transfers or
   FX of 100.00 or more, and unclear purpose verdicts. The owner approves exactly what was shown.
6. The ledger reserves funds, the rail pays, and the ledger confirms or releases. A timeout is
   unconfirmed and looked up, never paid twice.
7. On a purchase, the buyer's request carries a warrant pass. Our store checks it before serving
   and stores it with the signed order and the settlement transaction. A dispute is decided from
   that evidence, and a refund goes back to the order's payer by `mandate pull`.
8. STOP revokes every warrant, drops what is waiting and revokes the agents' mandates.

## Sponsor tooling used

**Metal (testnet, chain 63825)**

- `metal-agent` CLI 0.3.3: `account create`, `fund`, `mandate credential create`, `mandate bind`,
  `mandate status`, `mandate replace` (owner raises the cap), `mandate revoke` (STOP),
  `mandate pull` (refunds and moving earnings), and `pay` with the warrant pass sent as a header.
- `@metalntwx/metal-pay`: `requireSignedOffer` and `SIGNED_OFFER_REQUIRED` on our store's route,
  `signedOfferOf`, `onAfterSettle` to store each signed order with its transaction hash and a hash
  of what we delivered.
- Mandates enforce the same limits on chain. Evidence on testnet: purchases at 2 cents, a 4-cent
  purchase refused as `mandate_cap_exceeded`, the owner's `mandate replace`, and the old
  credential refused as `mandate_revoked` (transaction hashes in `docs/TESTNET.md`).
- The dispute scene runs on the mock chain. TODO: run the dispute and `verifyMandatePayment` on
  testnet, or say "mock chain" in the form.
- TODO: confirm the warrant pass on testnet (store and upstream checking passes in
  `RAILS_MODE=sandbox`) and record the evidence in `docs/TESTNET.md`.

**Airwallex (sandbox API shapes; runs against our mock today)**

- Adapter calls: `POST /api/v1/authentication/login`, `GET /api/v1/balances/current`,
  `POST /api/v1/fx/conversions/create`, `POST /api/v1/beneficiaries/create`,
  `POST /api/v1/transfers/create`, `GET /api/v1/transfers?request_id=`,
  `POST /api/v1/simulation/deposit/create` (earnings arrive with the Metal transaction hash as
  the reference), and the sandbox transfer simulation.
- Every write carries a `request_id` from control's idempotency key. A timeout is looked up by
  that id, never resent.
- TODO: no code path calls the real Airwallex sandbox yet. Either run the earnings and licence fee
  scene against the sandbox before we submit, or describe it as "built against the sandbox API,
  demoed on a mock".

**Visa**

- Airwallex virtual card for an agent, with limits and freeze on STOP: **in progress, #19**. Our
  Airwallex mock already models cardholders, cards, card transactions and freeze. TODO: update
  this line if #19 merges.

## What's next

- Finish the Airwallex virtual card and freeze (#19), and run the Airwallex side on the sandbox.
- Run the dispute on Metal testnet.
- Close the known gaps the benchmark shows: a flood from one offer still pays once (#79), and six
  attacks get through (named in the `pnpm bench` output).
- Grow the benchmark from 79 cases to 150+.
- Let the owner turn a repeated approval into a new signed warrant version ("always allow this").
- TODO: anything the team wants to add.

## Team

Eva, Max, Elisei, Jesse.

## Links

- Repo: TODO (public link, or confirm judges can access a private repo).
- Video: TODO (see `docs/VIDEO.md`).
- Live demo: TODO, if we host one.
