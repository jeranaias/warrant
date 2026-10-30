# @warrant/mocks

Local fake Airwallex and Metal servers so nobody waits on sandbox access.

- `src/airwallex/`: auth token, DELEGATE cardholders, issued cards (create, freeze with
  `POST /issuing/cards/{id}/update`), `single_phase` simulated purchases, `GET /issuing/transactions`,
  `GET /balances/current`, simulated deposits (`POST /simulation/deposit/create`, `GET /deposits`), FX
  quotes (`POST /fx/quotes/create`) and conversions (`POST /fx/conversions/create`,
  `GET /fx/conversions/{id}`). Still to do: beneficiaries and transfers.
- `src/metal/`: an x402 seller that answers 402 with payment requirements, settles, and reports
  status by idempotency key.

Rules:

- Shapes follow the real sandbox APIs. Check them with the Airwallex docs MCP (see RUNBOOK).
- The legacy `GET /issuing/transactions` answers `{has_more, items}` and refuses a `page_size` below 10
  (both confirmed against the real sandbox on 2026-10-30). Its item shape, and whether it shows pending and
  declined transactions, are unverified: the probe that seemed to show an empty list used a key whose
  account has no cards. The mock lists every simulated transaction. Use the simulate response for
  pending state.
- Seeding: `startAirwallexMock({ balances: { USD: 100 }, rates: { EURUSD: "1.122579" }, now })`.
  `rates` are decimal strings, one per market pair (BASEQUOTE, QUOTE per 1 BASE, so one entry covers both
  directions). `now` is a clock in ms for expiring quotes in tests.
- **Unseeded currencies are unlimited for cards but zero for conversions.** With no wallet for a
  currency, a card purchase is not funds-checked, but a conversion selling it is refused with
  `insufficient_funds`: a conversion needs real money behind it. Once a currency has a wallet (seeded
  or deposited), both check it. Conversions spend `available`, never funds a card has reserved.
- FX math is integer cents (BigInt, no floats). The derived side is rounded to the nearest cent, ties up,
  which matches six real sandbox quotes and conversions (floor and ceil each get some wrong); the tie
  direction is an assumption. Two-decimal currencies only.
- `GET /fx/conversions?request_id=` is how a caller checks a conversion after a timeout (never resend the
  `request_id`: the real API rejects it). Probed on 2026-10-30 with the key that made the conversion: it was
  found on the first request, about 1h45m after it was created. Right after creation is not probed for
  conversions (the real transfers list does show a new transfer in the same second), and the mock lists at
  once. An earlier note that this list lags was wrong: that probe went through the MCP, which is a different
  sandbox account and never had the conversion.
- The real conversion errors carry a `details` array with a `correlation_id`; the mock adds one.
- Anything the real sandbox was not asked is marked `ASSUMED` in `src/airwallex/index.ts`.
- Support fault injection: timeouts, duplicate responses, 5xx. Control must survive these.
- After a timed-out `POST /issuing/cards/create`, never resend: a reused card `request_id` is a 400, even
  with the same body. Find the card with `GET /issuing/cards?cardholder_id=`, then `GET /issuing/cards/{id}`
  for each candidate and compare its `request_id` (the list has none). Confirmed against the real sandbox
  on 2026-10-30 (through the MCP, create and list in the same account): a card created seconds earlier was
  in the list at once, so this works for cards.
- No real keys. Auth is strict: the Airwallex mock only accepts a bearer token it issued from
  `POST /api/v1/authentication/login` (which needs `x-client-id` and `x-api-key`, any values).
  Legacy shape, no `x-api-version`: the mock ignores that header.

Run: `pnpm mocks` (ports from `.env`: `MOCK_AIRWALLEX_PORT`, `MOCK_METAL_PORT`).
