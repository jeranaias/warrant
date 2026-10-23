# @warrant/mocks

Local fake Airwallex and Metal servers so nobody waits on sandbox access.

- `src/airwallex/`: auth token, balances, beneficiaries, transfers, conversions, issued cards
  (create, freeze), and the sandbox "simulate" calls the rails adapters use.
- `src/metal/`: an x402 seller that answers 402 with payment requirements, settles, and reports
  status by idempotency key.

Rules:

- Shapes follow the real sandbox APIs. Check them with the Airwallex docs MCP (see RUNBOOK).
- Support fault injection: timeouts, duplicate responses, 5xx. Control must survive these.
- No real keys. Mocks accept any token.

Run: `pnpm mocks` (ports from `.env`: `MOCK_AIRWALLEX_PORT`, `MOCK_METAL_PORT`).
