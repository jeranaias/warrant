# Metal testnet: our accounts and evidence

Chain `eip155:63825`. Explorer: https://testnet.metalntwx.com. Everything here is public on chain.
Keys and credentials live only in the owner's `METAL_HOME` (never in the repo, never given to an
agent). Created 2026-10-29 by the owner; mandates expire 2026-11-19.

## Accounts

| Role                          | Smart account                                |
| ----------------------------- | -------------------------------------------- |
| Business (our store, payTo)   | `0x50B476F235dD6021Bb32684eF6f0461bA8E00689` |
| Customer (simulated)          | `0x1aaD7613732Bc8DF1911B190a74c1B21ED69b201` |
| Upstream provider (simulated) | `0xB354A3b58D55f85ec6794ff427e3387d330393E2` |
| Earnings (treasury payouts)   | `0x69600321aE4B33a9A5B7DFdc19baB4360CE529E2` |

## Mandates (ADR-009 numbers)

| Mandate        | Principal | Cap  | Budget | Payees        | Mandate id                                                           |
| -------------- | --------- | ---- | ------ | ------------- | -------------------------------------------------------------------- |
| sourcing       | business  | 0.03 | 10     | upstream only | `0x627a1f225a62c2a5a45dc5380d9b153f3cd6973fa878281c64758537902734b8` |
| support        | business  | 0.50 | 4      | any (refunds) | `0x548507789563364169da5f8e4bb5be3b5e732262f9135814036193161528dbfe` |
| treasury       | business  | 6    | 6      | earnings only | `0x03494d9106f39f4203f106576672ef262193772455be52064e4b6d7907f22eda` |
| customer-agent | customer  | 0.05 | 2      | business only | `0x6908b0a2e62a939f6c16f3e899e4757d46033213fc9e57c50cb41c642c096374` |

The sourcing mandate above was replaced by the live scene runs on 2026-10-31 (see "Live scene
runs"). Current sourcing mandate: `sourcing-v5-1793415327805.json`, id
`0xd1549f88af4f7222126e7c51c8edc9abb45ed692f152b1e1b278a9c4622b8735`, cap 0.03, budget 10, upstream
only (day-one limits). `METAL_HOME/warrant-live/owner-state.json` always names the current one.

## Evidence (2026-10-29)

| What                                                     | Result                                                                                   |
| -------------------------------------------------------- | ---------------------------------------------------------------------------------------- |
| Customer buys `GET /query/fx-eurusd` at 5c, signed order | paid, order stored: `0x006872300714430c2909c0da6f5b72e650420bb4b76a132232ad63df3c9a5827` |
| Customer buys `GET /query/btc-usd` at 5c                 | paid: `0xdd4c5dc4ff5eedc96d9c8450b130e13f16d574eb6059467586996b1bbd59b993`               |
| Sourcing pays upstream 4c (cap 3c)                       | **refused on chain**: `mandate_cap_exceeded`, nothing sent                               |
| Sourcing pays upstream 3c (inclusive cap)                | paid: `0x68f0826c5e3637787a7bf1d1afe44031e6cb7bae1c5df02a2091e03ae2f97490`               |

## Running live

`RAILS_MODE=sandbox` runs the same engine and the same scene on testnet: the real `metal-agent`
pays through `MetalAdapter`, the owner's mandate changes go through `CliMetalOwnerOps`, the
upstream provider is a real x402 seller (`@metalntwx/metal-pay`) on `UPSTREAM_PORT` paid to its
account above, and our store runs on `STORE_PORT` (signed order + warrant pass required, orders
in the data dir). Airwallex stays on the in-memory rail in this command; the Airwallex beat runs on
the real sandbox with `pnpm scene:earnings --sandbox` (see "Airwallex sandbox" below).

```sh
RAILS_MODE=sandbox pnpm scene     # the price-rise + limit-change story, on chain (about 2 minutes)
pnpm reset:live                   # owner: sourcing back on day-one limits before the next run
RAILS_MODE=sandbox pnpm engine    # the engine API on testnet (plus upstream seller and store)
```

What it needs:

- `.env` with `METAL_HOME` and `METAL_RPC_URL` (from another checkout: `WARRANT_ENV_FILE=<path>`).
- `METAL_HOME/warrant-public.env`: public addresses and mandate ids (`pnpm setup:testnet` writes
  it). The engine reads `METAL_UPSTREAM_ADDRESS` from it.
- The CLI at `METAL_HOME/cli` (`npm i @metalntwx/metal-agent@0.3.3` there), or `METAL_AGENT_BIN`.

What it changes on chain: two 2-cent payments and one 4-cent payment from the business account to
the upstream account, and one `mandate replace` of sourcing (3-cent cap -> 4-cent cap; the old
credential is then refused as `mandate_revoked`). The refused attempts send nothing.
`pnpm reset:live` is a second `mandate replace` back to 3 cents. Each replace writes a new
credential file (`sourcing-v<N>-<time>.json`) into METAL_HOME and records it in
`WARRANT_DATA_DIR/owner-state.json` (default `METAL_HOME/warrant-live`). Old credential files stay
(history). At startup each warrant is signed from `mandate status`; the scene refuses to start
unless sourcing is on its day-one 3-cent cap.

After the kill switch (`POST /kill` in live mode revokes the sourcing and support mandates):

1. Move the revoked credential files (`sourcing*`, `support*`) out of METAL_HOME into a dated
   `revoked-YYYYMMDD/` folder, and move `warrant-live/owner-state.json` there too. Never delete.
2. `SKIP_FUND=1 SKIP_CUSTOMER=1 pnpm setup:testnet`: reuses the account keys, creates and binds
   fresh mandates, rewrites `warrant-public.env`. The payers keep their USDZ, so no faucet.
3. Update the mandate table above from `warrant-public.env`.

## Live scene runs (2026-10-31)

`RAILS_MODE=sandbox pnpm scene`, twice, with `pnpm reset:live` after each:

| Step                               | Run 1                                                                                   | Run 2                                                                                   |
| ---------------------------------- | --------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------- |
| buy at 2 cents                     | paid `0x9c5fe578fd92d68e3b55362b04d73d9bd0daac22b5a19df8b4c7b74ef86ed2a8`               | paid `0x2bcfc2621bfd6d2a86dd05b2561465b3c117027cb55efd17ce8cf145a0ad2ae9`               |
| buy at 2 cents                     | paid `0xf8f15c4c979d4e4c0815ed80a2ae7d3afec3f28ecd0d28ce87a450253fd518b7`               | paid `0x4a976215cc97f2733df758b95c31e562e9b2f71fb0f7addfdd663dbe2a5a369c`               |
| price 4 cents: buy at 4            | refused by our rules (`per_payment_cap`), no chain call                                 | same                                                                                    |
| agent claims 2 cents anyway        | refused at the rail: seller's 402 asks 4, approved 2; nothing signed                    | same                                                                                    |
| limits only: pay at 4              | **refused on chain**: `mandate_cap_exceeded`, nothing sent                              | same                                                                                    |
| owner approves 4-cent cap          | replaced: `0x15353bfe8f781331680bd1d45d1bc882cda08c6042b73148d261034430dfe097` (v2)     | replaced: `0xb3114a138a7de6f2a61bf825c8f68ecb2adfccfc57e93e8ac8f323b79e6b6524` (v4)     |
| buy at 4 cents (owner tapped once) | paid `0x3979bf6f412a4b11a8b1e172514c8b2f1d155812ecaf4f60f0f22ff0027c0a3a`               | paid `0x81c287ef79635e4dd0314d447acbe7764d7dc9d6b1e58288caf6608e058be35d`               |
| old credential tries to pay        | **refused on chain**: `mandate_revoked`                                                 | same                                                                                    |
| `pnpm reset:live`                  | replaced: `0x377cdfe0d776665a239bac6a1382ce89c8201ecbbc46b835644782004cd0d7fc` (v3, 3c) | replaced: `0xd1549f88af4f7222126e7c51c8edc9abb45ed692f152b1e1b278a9c4622b8735` (v5, 3c) |

## Live dispute run (TODO: owner)

`RAILS_MODE=sandbox pnpm scene:dispute` (#106). Fill in from the printed output; each hash is on
the explorer at `https://testnet.metalntwx.com/tx/<hash>`. No `pnpm reset:live` needed after it.

| Step                                                  | Result                                                     |
| ----------------------------------------------------- | ---------------------------------------------------------- |
| customer's agent buys `fx-eurusd` (order + pass)      | TODO: paid `0x...`, order `ord_...`                        |
| customer's agent buys `btc-usd` (order + pass)        | TODO: paid `0x...`, order `ord_...`                        |
| store checks the pass before serving (dashboard line) | TODO: owner key, mandate `0x...`, cap 0.05                 |
| store: the `fx-eurusd` batch was stale                | no chain call                                              |
| dispute "data was wrong" on both orders               | TODO: both verified on chain (`verifyMandatePayment`)      |
| support refunds the `fx-eurusd` order (mandate pull)  | TODO: refunded `0x...` (support mandate)                   |
| customer asks again, adds `ord_404`                   | TODO: `already_refunded`, `order_not_found`; no chain call |
| support tries the same refund again                   | TODO: refused by our rules (`refund_matches_order`)        |
| "my agent never agreed" on the `btc-usd` order        | TODO: `owner_authorized`, N of N checks hold               |

## Windows quirks (metal-agent 0.3.3)

- Run `node <cli>/dist/index.js`, not the `.cmd` shim: `execCliRunner` runs a `.js` bin under
  node (the engine's default bin is the one in `METAL_HOME/cli`).
- On Windows, `metal-agent` 0.3.3 prints a settled payment and then crashes on exit (`Assertion
failed ... async.c`, exit 127). The adapter treats a 2xx status plus a settlement hash as paid
  regardless of the exit code (tested in `packages/rails/src/metal/metal.test.ts`); owner
  operations are judged by their printed output and then checked with `mandate status`.
- An empty `METAL_FACILITATOR_URL` breaks `mandate pull`; the engine skips blank `.env` values.

## Faucet

`metal-agent fund <address> --network testnet`: about one grant a minute and a few a day per IP;
429s are common. Only the business and customer accounts need USDZ. The live scene needs none.

## Airwallex sandbox

`pnpm scene:earnings --sandbox` runs the earnings beat on the real Airwallex sandbox with the keys
in `.env` (`AIRWALLEX_BASE_URL`, `AIRWALLEX_CLIENT_ID`, `AIRWALLEX_API_KEY`). Metal stays on the
mock chain in this command. Each run makes new sandbox objects: a deposit, a conversion, a transfer.

| Step                                | Result (first live run, 2026-11-02)                        |
| ----------------------------------- | ---------------------------------------------------------- |
| Deposit into the USD Global Account | settled, reference = the (mock) Metal tx                   |
| USD to EUR conversion               | created, fee amount only                                   |
| EUR 50.00 licence fee, SWIFT        | transfer `5ea7d69d-e8f4-4919-aa0c-19a9af9758d1`, SCHEDULED |
| Sandbox moves it along              | PAID; control's ledger confirmed it                        |

EUR `LOCAL` transfers are refused on this account with `fee_unknown`, so the licensor is paid by
SWIFT (ADR-017).
