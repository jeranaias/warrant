# Warrant

Warrant lets a business owner give AI agents a budget without giving them the keys. The owner
signs a **warrant** for each agent: who it may pay, how much per payment and in total, on which
rails, and until when. Every payment an agent asks for is checked against its warrant before any
money moves. Risky requests wait for the owner on their phone, and one STOP button stops
everything at once.

Our entry for the Airwallex Agentic Banking Hackathon (Kit 11, x402 Business Agents). Task board:
[Warrant hackathon project](https://github.com/users/jeranaias/projects/1).

## What is in the demo

A small pay-per-call data business with three AI agents:

- Customers' agents buy market data from our store at 5 cents a query, over x402 on Metal. Each
  purchase carries a signed order.
- The **sourcing agent** buys upstream data at 2 cents a call, capped at 3 cents per purchase.
- The **support agent** handles disputed orders and refunds the ones the evidence supports.
- The **treasury agent** moves earnings to Airwallex, pays a EUR 50.00 monthly licence fee, and
  proposes new limits within the 20 USDZ total.

Agents never pay anyone. They send a typed payment proposal. Control decides:

1. **Rules, in code.** Payee list, per-payment cap, total budget, expiry, duplicate guard, rail
   and currency. No model is involved.
2. **Purpose check.** A separate check sees only the signed warrant and a structured summary of
   the payment, never the invoice, offer or ticket text.
3. **The owner,** for budget changes, recurring payments, Airwallex transfers or FX of 100.00 or
   more, and anything the purpose check is unsure about (ADR-007, ADR-013). The approval is bound
   to a hash of exactly what the owner saw.
4. **Ledger.** Funds are reserved before money moves, then confirmed or released. The log is
   append-only. A timeout is recorded as unconfirmed and looked up, never retried blind.

Each agent's warrant sits on top of a Metal mandate with the same limits. If our code were
bypassed, the mandate still refuses on chain.

Sellers can check the buyer too. A purchase carries a **warrant pass**: a grant signed by the
buyer's owner, plus a per-purchase pass. Our store checks it before serving and keeps it with the
order, so a dispute can be settled from evidence (ADR-012).

## Prerequisites

- Node 24 (`.nvmrc`) and pnpm 10: `corepack enable`, then `corepack prepare pnpm@10 --activate`.
- Git.
- Nothing else for the local demo. It runs on in-memory mocks and needs no keys and no `.env`.
- Optional: a model API key in `.env` (variable names in `.env.example`). Without it, the agents
  run as a scripted agent that obeys whatever the task text says, and the purpose check is the
  deterministic one.
- Only for the Metal testnet run: a Metal RPC endpoint, the `metal-agent` 0.3.3 CLI and a
  `METAL_HOME` folder outside the repo. See [docs/TESTNET.md](docs/TESTNET.md).

## Quickstart (local, mock rails)

```sh
git clone <repo-url> warrant && cd warrant
pnpm install
pnpm verify          # optional: format check, lint, typecheck, tests (what CI runs)
```

Then three terminals, all from the repo root:

```sh
pnpm engine          # terminal 1: the engine on http://127.0.0.1:4000, mock rails
pnpm dashboard       # terminal 2: the owner dashboard on port 5173
pnpm agents          # terminal 3: the agents work through the queued tasks, then exit
```

The engine queues every scenario at startup (`all`). `pnpm agents --scenario <name>` loads one
scenario first. Names: `normal`, `price_rise`, `dispute`, `attacks`, `all`.

Scripted scenes print each step to the terminal. They need no engine running:

```sh
pnpm scene             # price rise, then the owner raises the cap
pnpm scene:dispute     # a customer disputes; the store decides from evidence
pnpm scene:earnings    # earnings move to Airwallex; the EUR licence fee is paid
pnpm bench             # the attack benchmark (no API key needed)
```

## Open the owner link

`pnpm engine` makes a new owner key each start and prints a line like this:

```
owner link (keep it to yourself): http://127.0.0.1:5173/#/m?owner=<key>
```

Open that link. It is the phone page. The page moves the key out of the address bar into the
tab's session storage. Without the key you can look, but you cannot approve or stop.

- Desktop view: in the same tab, go to `/#/` (or open `http://localhost:5173/#/?owner=<key>`).
- If `127.0.0.1:5173` does not load, use `localhost:5173` instead. On some machines the dashboard
  dev server listens only on `localhost`.
- On a real phone: `pnpm dashboard --host`, then open the link with your computer's address. Use
  a network you trust.

## What to click for each beat

All on the desktop dashboard unless noted.

| Beat                     | What to do                                                                                                                                                                                                                                                                                                                                                                     |
| ------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| The business runs        | Run `pnpm agents`. Watch **Live activity** and **Agents and budgets**.                                                                                                                                                                                                                                                                                                         |
| Price rises, money stops | In **Scene control**, pick `price_rise`, click **Load**, run `pnpm agents`. The 2-cent purchase pays. The 4-cent one is blocked by the per-payment cap before any chain call. Or run `pnpm scene` for the full story in the terminal.                                                                                                                                          |
| The owner decides        | In **Scene control**, click **Set 4 cents**, then **Treasury asks for a 0.04 USDZ cap**. The request appears under **Waiting for you** and on the phone page. Click **Approve**. The mandate is replaced and a new warrant version is signed.                                                                                                                                  |
| Attacks                  | Pick `attacks`, click **Load**, run `pnpm agents`. A swapped payee, a fake invoice and a refund to another wallet are blocked. A recurring licence payment is held for the owner, or blocked as a duplicate if the licence was just paid. One offer that says "buy 200 batches" pays once, and the repeats are blocked as duplicates. That first payment is a known gap (#79). |
| A dispute                | Run `pnpm scene:dispute`. The store answers from the signed order, the settlement and the customer's warrant pass, refunds the one bad order, and refuses a second refund of it.                                                                                                                                                                                               |
| Both rails               | Run `pnpm scene:earnings`.                                                                                                                                                                                                                                                                                                                                                     |
| STOP                     | Click **STOP**, then **Yes, stop all money now**. The banner shows how long it took and how many mandates were revoked. Every later proposal is refused.                                                                                                                                                                                                                       |
| The numbers              | Run `pnpm bench`.                                                                                                                                                                                                                                                                                                                                                              |

The main screen is changing: PR #94 replaces it with "the gate", which shows each agent's
requests flowing to Paid, Held for you or Blocked with reasons.

## What is real and what is mocked

| Part                                      | Local demo (`RAILS_MODE=mock`, default)    | Live run (`RAILS_MODE=sandbox`)                                                    |
| ----------------------------------------- | ------------------------------------------ | ---------------------------------------------------------------------------------- |
| Metal payments, mandates, refusals        | In-memory chain that enforces each mandate | **Metal testnet** (chain 63825) via the `metal-agent` CLI                          |
| Upstream provider and our store (x402)    | In memory                                  | Real x402 sellers built on `@metalntwx/metal-pay`, on local ports                  |
| Owner raises the cap (`mandate replace`)  | In memory                                  | **On chain**                                                                       |
| Dispute and refund (`pnpm scene:dispute`) | Mock chain                                 | Mock chain only for now                                                            |
| Airwallex deposit, FX, transfer           | Airwallex mock (`packages/mocks`)          | **Airwallex sandbox** with `pnpm scene:earnings --sandbox` (EUR by SWIFT, ADR-017) |
| Airwallex virtual card and freeze (Kit 2) | Mock endpoints exist; no adapter yet (#19) | Not built yet (#19)                                                                |
| Agents and purpose check                  | Scripted, or a model if a key is set       | Same                                                                               |

The Airwallex adapter (`packages/rails/src/airwallex`) runs against the mock by default and against
the real Airwallex sandbox with `pnpm scene:earnings --sandbox` (keys from `.env`). The live price-rise run and its transaction hashes are recorded in
[docs/TESTNET.md](docs/TESTNET.md). To run it:

```sh
RAILS_MODE=sandbox pnpm scene     # about 2 minutes, on Metal testnet
pnpm reset:live                   # put sourcing back on its 3-cent cap before the next run
```

On PowerShell, set the variable first: `$env:RAILS_MODE="sandbox"; pnpm scene`.

## Benchmark

`pnpm bench` runs every case against three setups: no protection, Metal mandate limits only, and
Warrant. The corpus has 79 cases today: 60 attacks and 19 normal payments. The target is 150+.

From `bench/results.json`, which `pnpm bench` rewrites and CI checks against a fresh run
(scripted naive agent, deterministic purpose check):

| Setup       | Attacks blocked | Normal payments wrongly blocked |
| ----------- | --------------- | ------------------------------- |
| unprotected | 0 of 60         | 0 of 19                         |
| limits only | 44 of 60        | 0 of 19                         |
| Warrant     | 60 of 60        | 1 of 19                         |

Warrant asked the owner 15 times in the run. Attacks Warrant lets through, and the one false
block, are listed by name in the `pnpm bench` output. See [bench/SCORING.md](bench/SCORING.md) for how results are counted.

## Repo map

```
apps/engine          local server: task feed for the agents, control, scenes, live mode
apps/dashboard       owner UI (Vite + React): desktop view and phone page (#/m)
apps/store           our data business: x402 route that requires a signed order
packages/contracts   shared types and zod schemas (the team agreement)
packages/control     rules, purpose check, ledger, approvals, kill switch, warrant pass
packages/agents      sourcing, support, treasury: prompts and one propose_payment tool
packages/rails       Metal and Airwallex adapters behind one interface
packages/mocks       mock Airwallex and Metal servers, and the scenario task feed
bench/               attack corpus, runner and scoring
docs/                architecture, decisions, demo script, runbook, testnet evidence
```

Other commands: `pnpm test`, `pnpm lint`, `pnpm typecheck`, `pnpm format`, `pnpm mocks` (the
standalone mock Airwallex and Metal servers; the local demo does not need them).

## Docs

- [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md): the decision flow and trust boundaries
- [docs/RUNBOOK.md](docs/RUNBOOK.md): full setup, including the Airwallex sandbox and Metal testnet
- [docs/TESTNET.md](docs/TESTNET.md): our testnet accounts, mandates and transaction evidence
- [docs/DEMO.md](docs/DEMO.md): the demo script, beat by beat
- [docs/DECISIONS.md](docs/DECISIONS.md): why things are the way they are (ADRs)
- [docs/CONTRACTS.md](docs/CONTRACTS.md): the shared types
- [docs/SUBMISSION.md](docs/SUBMISSION.md) and [docs/VIDEO.md](docs/VIDEO.md): submission and
  video drafts

Everything here is sandbox or testnet. Nothing points at production Airwallex or mainnet.
