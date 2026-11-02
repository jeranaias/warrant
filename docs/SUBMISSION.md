# Submission form: draft

Draft text for the hackathon submission form. Anything marked TODO is not verified yet. Check each
one before we submit (target Nov 12).

## Project name

Warrant

## One-line description

The owner signs a warrant for each AI agent, and every payment the agent asks for is checked
against it before any money moves.

## Demo link

https://warrant-demo-bt31.onrender.com (access code in the form's private notes field, not here).
Each visitor gets their own demo engine on mock rails, reset with one button. It runs on a free
host, so the first visit after a quiet spell can take up to a minute to wake.

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

**Airwallex (runs on the real sandbox: `pnpm scene:earnings --sandbox`)**

- Adapter calls: `POST /api/v1/authentication/login`, `GET /api/v1/balances/current`,
  `POST /api/v1/fx/conversions/create`, `POST /api/v1/beneficiaries/create`,
  `POST /api/v1/transfers/create`, `GET /api/v1/transfers?request_id=`,
  `POST /api/v1/simulation/deposit/create` (earnings arrive with the Metal transaction hash as
  the reference), and the sandbox transfer simulation.
- Every write carries a `request_id` from control's idempotency key. A timeout is looked up by
  that id, never resent.
- Live on the sandbox (2026-11-02): earnings deposited into our USD Global Account, converted USD to
  EUR, the EUR 50.00 licence fee sent by SWIFT and moved to PAID; control's ledger confirmed it.
  EUR SEPA is refused on the hackathon account (`fee_unknown`), so the licensor is paid by SWIFT
  (ADR-017, evidence in docs/TESTNET.md).

**Visa**

- An agent buys a design tool seat with an Airwallex virtual Visa card whose limits are the
  warrant's: USD 15.00 per purchase, USD 50.00 in all, merchant category 5734 only (ADR-018).
- Live on the sandbox (2026-11-02): the USD 12.00 seat was approved; a USD 40.00 purchase was
  blocked by control (`per_payment_cap`) and declined by the card itself (`LIMIT_EXCEEDED`); STOP
  froze the card in 627 ms, and the next purchase was refused as `CARD_INACTIVE`.

## What's next

- Close the known gaps the benchmark shows: a flood of purchases from one offer still pays once
  (#79; control can't see quantity without reading offer text, which it never does), and the
  attacks that get through (named in the `pnpm bench` output).
- Grow the benchmark from 79 cases to 150+.
- Let the owner turn a repeated approval into a new signed warrant version ("always allow this").
- TODO: anything the team wants to add.

## Team

Eva, Max, Elisei, Jesse.

## Links

- Repo: TODO (public link, or confirm judges can access a private repo).
- Video: TODO (see `docs/VIDEO.md`).
- Live demo: TODO, if we host one.
