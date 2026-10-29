# Hackathon facts

Collected 2026-10-23 from the event pages and the builder guide; updated 2026-10-29. Check the
sources before relying on anything marked NOT FOUND.

Sources: https://airwallex.hackerearth.com/,
https://airwallexdev.com/agentic-banking-builder-guide.md, https://docs.metalntwx.com/agents/

## Dates and submission

- Build: Oct 26-27 to **Nov 13, ~10:29 AM PT** (no exact time stated). We ship Nov 12.
- Finalists Nov 15. Demo Day Nov 19, San Francisco (remote optional).
- Submit: a working demo, a video walkthrough **under five minutes**, a repo link **with setup
  instructions**.
- Team: max 4 registered. A 5th person may support offline only (advisor/reviewer; no code).
- Prizes: Founder's Choice $30K, Judges Choice $20K, Visa Award $15K (Visa + Airwallex tooling),
  Metal Award $15K (Metal + Airwallex tooling). We aim at both sponsor awards.
- NOT FOUND: judging criteria, pre-existing code rules, whether the repo must be public, which IP
  terms govern.

## Kit 11: x402 Business Agents (our main kit)

We run a data business. Customers' agents buy market data per query, pay into our Metal account
and sign each order. Three agents work from that account, each under its own mandate: **sourcing**
buys upstream data; **support** refunds customers; **treasury** monitors spending, moves earnings
to Airwallex and pays a monthly licence fee invoiced in euros. We also simulate the customer, the
customer's agent and the upstream provider.

The decision: treasury proposes new limits within the 20 USDZ total (with or without a higher
query price); the owner approves by replacing the mandates. On a disputed batch, the agent checks
the signed orders and support refunds if the data sold was wrong. Prices, budgets and the licence
fee stay in code.

| Item           | Value                                               |
| -------------- | --------------------------------------------------- |
| Total budget   | 20 USDZ (enforced in code)                          |
| Sourcing       | 10 USDZ, at most 3 cents per purchase               |
| Support        | 4 USDZ                                              |
| Treasury       | 6 USDZ                                              |
| Query price    | 5 cents                                             |
| Upstream price | 2 cents, then 4 cents: the next purchase is refused |

Required tools: `metal-agent` (account create; mandate credential create, bind, replace, pull with
one `--payment-id` per refund, verify; `--mandate-key-file` for a replacement);
`@metalntwx/metal-pay` (`requireSignedOffer`, `signedOfferOf`, `verifyMandatePayment`,
`onAfterSettle`, `SIGNED_OFFER_REQUIRED` on the route); Airwallex
`POST /api/v1/simulation/deposit/create`, `GET /api/v1/deposits`, and the FX, beneficiary and
transfer calls.

Rules: mandates pay whole cents only; an over-cap purchase moves nothing and returns a 402 naming
the reason. A replacement mandate carries spend forward, so its budget must exceed what is spent;
old credentials are refused as revoked. Never give an agent an owner key. Store each signed order
with its transaction hash and what was delivered (nothing stores them for you). The Airwallex
sandbox can't receive stablecoins: send earnings to a Metal address we control, then simulate a
deposit with the transaction hash as reference.

Checklist: (1) accounts + mandates, including a customer account and mandate; (2) upstream
provider + a route requiring a signed order; (3) sell queries, record each signed order; (4) raise
the upstream price, show the sourcing refusal; (5) replace the mandates with treasury's proposed
limits; (6) resolve the disputed batch, show the refund decision; (7) move earnings to Airwallex,
then pay the licence fee.

## Kit 2: Intent-bound purchase (our virtual card)

API prefix `https://api.sandbox.airwallex.com/api/v1`: `POST /issuing/cardholders/create`,
`POST /issuing/cards/create`, `GET /issuing/cards/{id}/limits`, `POST /issuing/cards/{id}/update`
(freeze); simulation `POST /simulation/issuing/create`, `.../{transaction_id}/capture`,
`.../reverse`, `/simulation/issuing/refund`; `GET /issuing/transactions`.

Rules: fund the wallet before issuing. Treat `transaction_type: CLEARING` as accepted and read
`failure_reason` for declines. Limits are inclusive. PER_TRANSACTION limits aren't cumulative:
pair with ALL_TIME or MONTHLY. Declined cards end FAILED; failed transfers end CANCELLED. MCP field
`cardholder_type` = REST field `type`. Poll for ready status. Decline reasons: INSUFFICIENT_FUNDS,
LIMIT_EXCEEDED, CURRENCY_NOT_ALLOWED, MERCHANT_CATEGORY_NOT_ALLOWED, OUT_OF_ALLOWED_TIME_RANGE,
CARD_INACTIVE, CARD_CLOSED.

Checklist: fund the wallet; create a card with per-transaction + cumulative limits, a currency
allowlist and merchant categories; one authorization passes, one fails; show the decline reason
matching the policy; freeze the card; read transactions back.

## Metal testnet

- Chain `eip155:63825` (`0xf951`). Explorer: testnet.metalntwx.com. Console:
  https://console-testnet.metalntwx.com/ (RPC endpoint from `/endpoints`). Faucet:
  https://faucet.metalntwx.com/ (100 units per grant; 10 per IP per day; one per minute).
- CLI `@metalntwx/metal-agent@0.3.3`. `pay --max` defaults to 1 USDZ. Mandates expire in 30 days by
  default; budgets never reset (`renew` resets, `replace` carries forward). Exit codes: 1 refused,
  3 pending, 4 held.
- Refusal codes: `mandate_payee_not_listed`, `mandate_cap_exceeded`, `mandate_budget_spent`,
  `mandate_occurrences_used`, `mandate_outside_recurrence`, `mandate_expired`, `mandate_revoked`,
  `mandate_not_bound`, `mandate_bad_signature`, `mandate_outside_window`, `mandate_nonce_used`,
  `transfer_would_fail`.
- USDZ is the dollar token and pays gas; clearing uses 18-decimal base units; mandate payments are
  whole cents. Uncertain outcomes: facilitator `/settlements?payTo=<payee>`.

## Airwallex sandbox

- Sign up at https://sandbox.airwallex.com with a real email; name the business "Sandbox
  Business" or "New Business Sandbox" (auto-approved).
- Account > Developer > API keys: client id + API key. `POST /api/v1/authentication/login` with
  `x-client-id` and `x-api-key`, no body: bearer token valid 30 minutes.
- Major units ("100 is one hundred dollars"). UUID `request_id` for idempotency; reuse only to
  retry the same operation. Transfer ids 10-50 characters. On an ambiguous response, query by
  request id before retrying. Rate limits: 20/s global, 10/s per endpoint, 10 concurrent.
- FX: omit `x-api-version`; a rate is not a quote. SWIFT payouts have a flat fee; LOCAL are free.
- Simulated deposit shows PENDING but the balance updates immediately.
- Webhooks: verify HMAC-SHA256 on raw bytes, dedupe on event id, return 200 fast.
- Help: devhelp@airwallex.com. HackerEarth Discussion tab for event questions.
