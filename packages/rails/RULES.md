# packages/rails

**Purpose:** adapters for Metal (`metal/`, x402 via `@metalntwx/metal-pay`) and Airwallex
(`airwallex/`: transfer, FX, card) behind ONE `RailAdapter` interface (`src/types.ts`). Each has a
`mock` and a `sandbox` implementation so sandbox-only simulation calls can be swapped in.

**May import:** `@warrant/contracts`, `@metalntwx/metal-pay` and its peers, HTTP client, node
built-ins.

**Must never:**

- Import `@warrant/agents` or `@warrant/control` (control calls rails, not the reverse).
- Decide whether a payment is allowed. Rails execute what control already approved and reserved.
- Return `failed` on a timeout. Ambiguous outcomes are `unknown`; control checks `getStatus()`.
- Convert units anywhere except here: cents <-> USDZ 18-decimal base units (bigint);
  cents <-> Airwallex major units (decimal string). No float math.
- Expose card PAN/CVV or API keys in return values, errors or logs.
- Point at production Airwallex or mainnet.
