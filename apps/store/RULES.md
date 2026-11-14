# apps/store

**Purpose:** our data business (Kit 11). Sells market data per query over x402 on Metal at the
price in `@warrant/control` `QUERY_PRICE`. Every route requires the buyer's **signed order**
(`requireSignedOffer` + `SIGNED_OFFER_REQUIRED`), one route per item so the order names what was
bought. After each first settlement, `onAfterSettle` stores a `SignedOrderRecord` (signed order,
tx hash, payer, sha256 of what we delivered). Support's dispute flow reads those records.
With `passes` set (on by default in sandbox, `STORE_REQUIRE_PASS`), an item is served only to a
buyer whose warrant pass (`x-warrant-pass`, ADR-012) checks out; the record keeps the pass.
`verify.ts` checks a stored order's settlement on chain for disputes (metal-pay
`verifyMandatePayment` over its tx and signed order; never returns the RPC URL).

**May import:** `@warrant/contracts`, `@warrant/control` (constants, and `PassChecker` in `main.ts` only), `@metalntwx/metal-pay`,
`@x402/*` (pinned to the version metal-pay resolves, so there is one `x402ResourceServer` type), `express`, `viem`, node built-ins.

**Must never:**

- Set a price anywhere but `QUERY_PRICE` (ADR-009).
- Do paid work that can't be undone before settlement, or return >= 400 after paid work
  (that cancels the payment).
- Edit or delete a stored order. The file is append-only.
- Log the signed order's contents, keys or the RPC URL.
