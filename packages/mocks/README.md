# @warrant/mocks

Local fake Airwallex and Metal servers so nobody waits on sandbox access.

- `src/airwallex/`: auth token, balances, beneficiaries, transfers, conversions, issued cards
  (create, freeze), and the sandbox "simulate" calls the rails adapters use.
- `src/metal/`: an x402 seller that answers 402 with payment requirements, settles, and reports
  status by idempotency key.

Rules:

- Shapes follow the real sandbox APIs. Check them with the Airwallex docs MCP (see RUNBOOK).
- Support fault injection: timeouts, duplicate responses, 5xx. Control must survive these.
- After a timed-out `POST /issuing/cards/create`, never resend: a reused card `request_id` is a 400, even
  with the same body. Find the card with `GET /issuing/cards?cardholder_id=`, then `GET /issuing/cards/{id}`
  for each candidate and compare its `request_id` (the list has none). Confirmed against the real sandbox
  on 2026-10-30: a card created seconds earlier was in the list at once, so this works for cards, unlike
  the transactions and conversions lists, which lag.
- No real keys. Auth is strict: the Airwallex mock only accepts a bearer token it issued from
  `POST /api/v1/authentication/login` (which needs `x-client-id` and `x-api-key`, any values).
  Legacy shape, no `x-api-version`: the mock ignores that header.

Run: `pnpm mocks` (ports from `.env`: `MOCK_AIRWALLEX_PORT`, `MOCK_METAL_PORT`).
