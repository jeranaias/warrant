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

## Evidence (2026-10-29)

| What                                                     | Result                                                                                   |
| -------------------------------------------------------- | ---------------------------------------------------------------------------------------- |
| Customer buys `GET /query/fx-eurusd` at 5c, signed order | paid, order stored: `0x006872300714430c2909c0da6f5b72e650420bb4b76a132232ad63df3c9a5827` |
| Customer buys `GET /query/btc-usd` at 5c                 | paid: `0xdd4c5dc4ff5eedc96d9c8450b130e13f16d574eb6059467586996b1bbd59b993`               |
| Sourcing pays upstream 4c (cap 3c)                       | **refused on chain**: `mandate_cap_exceeded`, nothing sent                               |
| Sourcing pays upstream 3c (inclusive cap)                | paid: `0x68f0826c5e3637787a7bf1d1afe44031e6cb7bae1c5df02a2091e03ae2f97490`               |

## Known quirk

On Windows, `metal-agent` 0.3.3 prints a settled payment and then crashes on exit (`Assertion
failed ... async.c`, exit 127). The adapter treats a 2xx status plus a settlement hash as paid
regardless of the exit code (tested in `packages/rails/src/metal/metal.test.ts`).
