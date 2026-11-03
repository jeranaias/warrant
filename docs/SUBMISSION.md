# Submission form: draft

Text for the hackathon submission form (target Nov 12). Every number and transaction here is in
the repo (`bench/results.json`, `docs/TESTNET.md`, `docs/DECISIONS.md`). Anything marked TODO is
still open.

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
hidden instructions in that text cannot reach it. Budget changes, a second bill in the same
billing period, Airwallex transfers of 100.00 or more and unclear cases wait for the owner, who
approves exactly what was shown. One STOP refuses every payment from then on and revokes the
agents' mandates.

The demo is the Kit 11 data business: three agents (sourcing, support, treasury) buy upstream
data, settle disputes and pay a EUR licence fee, over x402 on Metal and through Airwallex. Each
warrant sits on a Metal mandate with the same limits, so the chain still enforces them if our
code is bypassed. Our store checks a buyer's warrant pass before serving and decides disputes
from its signed records. On our benchmark Warrant blocks 150 of 155 attacks, against 110 for
mandate limits alone. The hosted demo runs on simulated money; the same flows ran on the
Airwallex sandbox and Metal testnet (evidence below).

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
- Mandates enforce the same limits on chain (live runs 2026-10-31): purchases at 2 cents paid; with
  our rules off, a 4-cent purchase was refused on chain as `mandate_cap_exceeded`; the owner's
  `mandate replace` raised the cap; the old credential was then refused as `mandate_revoked`.
- A seller can prove an agent paid under a mandate a human signed (live run 2026-11-02,
  `RAILS_MODE=sandbox pnpm scene:dispute`): the customer's agent bought two queries from our store,
  each with a signed order and a warrant pass; the store checked the pass before serving (owner
  key, customer mandate, 0.05 cap) and verified both settlements with `verifyMandatePayment`.
- Disputes are decided from the store's own records: "data was wrong" on both orders refunded the
  stale one (5 cents back by `mandate pull`) and kept the correct one; asking again was refused
  (`already_refunded`, `order_not_found`, then `refund_matches_order`); "my agent never agreed"
  was rejected with 11 of 11 checks holding. Transaction hashes, with explorer links, are in
  `docs/TESTNET.md`.
- A payment in doubt (timeout, lost answer) is never resent: it stays unconfirmed with its amount
  held, and a status check settles it before the next decision (ADR-019). On Metal this uses the
  settlement lookup by nonce: on testnet it asks the USDZ token whether the payment's nonce was
  used and finds the transaction that used it (#130); tested against the mock chain's faults
  (#123, #124).

**Airwallex (runs on the real sandbox: `pnpm scene:earnings --sandbox`)**

- Adapter calls: `POST /api/v1/authentication/login`, `GET /api/v1/balances/current`,
  `POST /api/v1/fx/conversions/create`, `POST /api/v1/beneficiaries/create`,
  `POST /api/v1/transfers/create`, `GET /api/v1/transfers?request_id=`,
  `POST /api/v1/simulation/deposit/create` (earnings arrive with the Metal transaction hash as
  the reference), and the sandbox transfer simulation.
- Every write carries a `request_id` from control's idempotency key. A timeout leaves the transfer
  unconfirmed with its amount held; a status check by that id settles it before the next decision,
  and it is never resent (ADR-019, tested against the Airwallex mock's timeout and duplicate
  faults, #122).
- A second bill from the licensor in the same month waits for the owner, with the reason "bills
  once a month and was already paid this month" (ADR-015). The hosted demo shows this one.
- The owner's screen is a decision desk: held requests first, then every paid and blocked
  request as one sentence with its reason, repeats folded. Any line opens a step-by-step replay
  of that request from the event log: each of the 9 rules with pass or fail, the purpose check,
  the owner's decision with the hash of what was shown, funds held, confirmed or released, and
  the rail's result (`GET /api/replay`, #132, #133).
- Live on the sandbox (2026-11-02): earnings deposited into our USD Global Account, converted USD to
  EUR, the EUR 50.00 licence fee sent by SWIFT and moved to PAID; control's ledger confirmed it.
  EUR SEPA is refused on the hackathon account (`fee_unknown`), so the licensor is paid by SWIFT
  (ADR-017, evidence in docs/TESTNET.md).

**Visa**

- An agent buys a design tool seat with an Airwallex virtual Visa card whose limits are the
  warrant's: USD 15.00 per purchase, USD 50.00 in all, merchant category 5734 only (ADR-018).
- Live on the sandbox (2026-11-02): the USD 12.00 seat was approved; a USD 40.00 purchase was
  blocked by control (`per_payment_cap`) and, sent straight to the card, declined by the card
  itself (`LIMIT_EXCEEDED`); STOP froze the card in 627 ms, and the next purchase was declined as
  `CARD_INACTIVE` (`pnpm scene:card --sandbox`, evidence in `docs/TESTNET.md`).
- The card number and CVV are never fetched; the agent never sees them.

## Benchmark

`pnpm bench` runs every case against three setups (scripted agent, deterministic purpose check;
numbers from `bench/results.json`, which CI checks against a fresh run):

| Setup       | Attacks blocked | Normal payments wrongly blocked |
| ----------- | --------------- | ------------------------------- |
| unprotected | 0 of 155        | 0 of 30                         |
| limits only | 110 of 155      | 0 of 30                         |
| Warrant     | 150 of 155      | 1 of 30                         |

Warrant asked the owner 31 times in the run. On a held-out set of 34 cases written by someone who
did not build control, Warrant blocks 26 of 28 attacks and wrongly blocks 1 of 6 normal payments.

A separate run with a real model (Haiku as agent and purpose check, 3 Nov, PR #143): Warrant
blocked 137 of 154 attacks and held 3 of 31 normal payments; limits only 122, no protection 111
(the model alone ignores most injected text). Held-out: 25 of 28. That run predates ADR-021's relabel (bench/SCORING.md). A model run varies run to run,
so the scripted numbers above are the published ones.

Labels changed after seeing a model run: after the first model run, 56 cases (9 of them held-out)
got `expected.legit`, which counts paying the genuine bill as correct instead of as a miss. The
scripted results did not change. The case ids and the reason are in
[bench/SCORING.md](../bench/SCORING.md).

## Known limits

- 5 of 155 attacks get through, and 1 of 30 normal payments is wrongly held. Each has the same
  structured shape as a normal payment, and control never reads invoice or offer text; the cases,
  their twins and what would close them are in [bench/README.md](../bench/README.md).
- On live testnet, the lookup finds the payment's transaction only within about 40 minutes
  (50,000 blocks); an older one is still settled as paid, identified by its nonce (ADR-019).
- The hosted demo runs on simulated money with a scripted agent. The sponsor rails ran live from a
  laptop (`docs/TESTNET.md`), not from the hosted demo.
- The licence's "once a month" is 28 days, so a second bill on day 29 to 31 of a long month is not
  caught by that rule (ADR-015).

## What's next

- Close the attacks that still get through ([bench/README.md](../bench/README.md)).
- Let the owner turn a repeated approval into a new signed warrant version ("always allow this").

## Team

- truelumpen: AI Engineer
- Eva, Max, Jesse: TODO: confirm names and roles as they should appear.

## Links

- Live demo: https://warrant-demo-bt31.onrender.com (access code in the form's private notes).
- Repo: TODO (public link, or confirm judges can access a private repo).
- Video: TODO (see `docs/VIDEO.md`).
