# @warrant/mocks

Local fake Airwallex and Metal servers so nobody waits on sandbox access.

- `src/airwallex/`: auth token, DELEGATE cardholders, issued cards (create, freeze with
  `POST /issuing/cards/{id}/update`), `single_phase` simulated purchases, `GET /issuing/transactions`,
  and `GET /balances/current`. Pass `startAirwallexMock({ balances: { USD: 100 } })` to seed a wallet;
  without it there is no funds check. Still to do: beneficiaries, transfers, conversions.
- `src/metal/`: an x402 seller that answers 402 with payment requirements, settles, and reports
  status by idempotency key.

Rules:

- Shapes follow the real sandbox APIs. Check them with the Airwallex docs MCP (see RUNBOOK).
- The real legacy `GET /issuing/transactions` returned nothing for pending or declined transactions on
  2026-10-30. They may only show once settled. Don't rely on this list for pending state; use the
  simulate response. The mock lists them anyway, and enforces the sandbox's `page_size` minimum of 10.
- Support fault injection: timeouts, duplicate responses, 5xx. Control must survive these.
- No real keys. Auth is strict: the Airwallex mock only accepts a bearer token it issued from
  `POST /api/v1/authentication/login` (which needs `x-client-id` and `x-api-key`, any values).
  Legacy shape, no `x-api-version`: the mock ignores that header.

Run: `pnpm mocks` (ports from `.env`: `MOCK_AIRWALLEX_PORT`, `MOCK_METAL_PORT`).
