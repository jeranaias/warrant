# Warrant

Give AI agents a budget without giving them the keys.

The owner signs a **warrant** for each agent: who it may pay, how much per payment and in total,
on which rails, and until when. Every payment an agent asks for is checked against it before any
money moves. Risky requests wait for the owner, and one STOP button stops everything.

![Warrant demo: agents' requests flow through the warrant to paid, held or blocked; the store checks a buyer's warrant pass and settles a dispute; the owner approves a held bill; STOP revokes every warrant](docs/media/warrant-demo.gif)

**Try it:** https://warrant-demo-bt31.onrender.com (access code from the team). Press **Run a
scenario**, decide what is held for you, then press **STOP**. Simulated money; each visitor gets
their own copy. The first visit after a quiet spell can take a minute to wake.

Our entry for the Airwallex Agentic Banking Hackathon (Kit 11, x402 business agents) ·
[task board](https://github.com/users/jeranaias/projects/1)

## How it works

Agents never pay anyone. They send a typed payment proposal, and control decides in four steps:

| Step              | What it checks                                                                                                                                       |
| ----------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Rules**         | Payee list, per-payment cap, total budget, expiry, repeats, rail and currency. Code only, no model.                                                  |
| **Purpose check** | Sees the signed warrant and a structured summary, never the invoice, offer or ticket text, so instructions hidden in that text can't reach it.       |
| **Owner**         | Budget changes, recurring bills, large transfers, unclear cases. The approval is bound to a hash of exactly what the owner saw (ADR-007, ADR-013).   |
| **Ledger**        | Funds reserved, then confirmed or released. Append-only. A timeout is recorded as unconfirmed and settled by a status check, never resent (ADR-019). |

Each warrant sits on a **Metal mandate** with the same limits, so the chain still refuses if our
code is bypassed. Sellers can check the buyer too: a purchase carries a **warrant pass** signed by
the buyer's owner, which our store verifies before serving and keeps for disputes (ADR-012).

The demo business: customers' agents buy market data from our store over x402 on Metal. A
**sourcing** agent buys upstream data, a **support** agent settles disputed orders, and a
**treasury** agent moves earnings to Airwallex and pays a EUR licence fee.

## What ran for real

The hosted demo runs on simulated money. The same flows were run on the real sandboxes, with
evidence in [docs/TESTNET.md](docs/TESTNET.md) (also under **Live runs** in the demo):

| Flow                     | Where             | Result                                                                                                         |
| ------------------------ | ----------------- | -------------------------------------------------------------------------------------------------------------- |
| Price rise, cap on chain | Metal testnet     | 4-cent purchase refused by the rules, and by the mandate on chain; owner raises the cap with `mandate replace` |
| Dispute                  | Metal testnet     | Pass checked, bad order refunded by mandate pull, repeat refund refused, "never agreed" rejected (11 of 11)    |
| Earnings and licence fee | Airwallex sandbox | Deposit, USD to EUR, EUR 50.00 by SWIFT, PAID (ADR-017)                                                        |
| Virtual Visa card        | Airwallex sandbox | Seat bought; USD 40 blocked by control and declined by the card; STOP froze the card in 627 ms (ADR-018)       |

## Benchmark

`pnpm bench`: 154 attacks across 14 families and 31 normal payments, against three setups. From
[bench/results.json](bench/results.json), which CI checks against a fresh run:

| Setup       | Attacks blocked | Normal payments wrongly blocked |
| ----------- | --------------- | ------------------------------- |
| unprotected | 0 of 154        | 0 of 31                         |
| limits only | 107 of 154      | 0 of 31                         |
| Warrant     | 149 of 154      | 1 of 31                         |

On a held-out set written by someone who didn't build control: 25 of 28 attacks blocked, 1 of 6
normal payments wrongly blocked. The misses are named in the `pnpm bench` output
([bench/SCORING.md](bench/SCORING.md)).

## Run it locally

Node 24+ and pnpm 10 (`corepack enable` once). No keys and no `.env` for the mock demo.

```sh
git clone https://github.com/jeranaias/warrant.git && cd warrant   # private: needs repo access
pnpm install
pnpm build:hosted
DEMO_PASSWORD=pick-one DEMO_COOKIE_SECRET=any-16-or-more-chars pnpm start:hosted
# open http://localhost:10000, type the code you picked, press Run a scenario
```

On PowerShell, set the variables first: `$env:DEMO_PASSWORD="pick-one"`, and the same for
`DEMO_COOKIE_SECRET`.

Each beat as a terminal scene (no server needed):

```sh
pnpm scene             # price rise, then the owner raises the cap
pnpm scene:dispute     # a customer disputes; the store decides from evidence
pnpm scene:earnings    # earnings to Airwallex, then the EUR licence fee
pnpm scene:card        # virtual Visa card: one purchase, one decline, STOP freezes it
pnpm bench             # the attack benchmark
```

Add `RAILS_MODE=sandbox` (Metal testnet) or `--sandbox` (Airwallex sandbox) to run on the real
rails; setup is in [docs/RUNBOOK.md](docs/RUNBOOK.md).

<details>
<summary>Development setup (engine, dashboard and agents as separate processes)</summary>

```sh
pnpm verify          # format check, lint, typecheck, tests (what CI runs)
pnpm engine          # terminal 1: engine on http://127.0.0.1:4000, mock rails
pnpm dashboard       # terminal 2: dashboard on http://localhost:5173
pnpm agents          # terminal 3: agents work through the queued tasks, then exit
```

The engine queues every scenario at startup. Nothing pays until `pnpm agents` runs, and pressing
**Run** in the dashboard only queues tasks. `pnpm agents --scenario <name>` loads one scenario:
`normal`, `price_rise`, `dispute`, `attacks`, `all`.

`pnpm engine` prints an owner link (`http://localhost:5173/#/m?owner=<key>`). Open it to approve
and stop; without the key you can look but not act. The page moves the key into the tab's session
storage. `/#/` is the desktop view; narrow screens get the phone page by themselves. On a real
phone, run `pnpm dashboard --host` on a network you trust.

A model API key in `.env` (names in `.env.example`) is optional. Without one, the agents are
scripted and the purpose check is deterministic.

</details>

<details>
<summary>What to click for each beat</summary>

| Beat                     | What to do                                                                                                                                                                                 |
| ------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| The business runs        | **Run a scenario**. Each request flows to Paid, Held for you or Blocked, with the reason. **Activity** lists every step.                                                                   |
| The seller checks        | The **seller's view** shows the store checking each buyer's warrant pass, refusing a buyer without one, and deciding disputes order by order.                                              |
| The owner decides        | A second licence bill in the same month is held. Approve or deny it in the waiting card (or on the phone page).                                                                            |
| Price rises, money stops | **Scenarios** → **Supplier raises the price** → **Run**. The 4-cent purchase is blocked by the per-payment cap before any chain call.                                                      |
| New limits               | **Scenarios** → **Raise to 4 cents**, then **Treasury asks to set the sourcing cap to 0.04 USDZ** → **Sign new limits**. The mandate is replaced and a new warrant version is signed.      |
| Attacks                  | **Attacks on the agents** → **Run**. A swapped payee, a fake invoice and a refund to another wallet are blocked. "Buy 200 batches" pays once and the repeats are blocked (known gap, #79). |
| STOP                     | **STOP** → **Yes, stop all money now**. Every warrant and mandate is revoked; every later proposal is refused.                                                                             |
| Live evidence            | **Live runs** lists the sandbox and testnet runs with links to the transactions.                                                                                                           |

</details>

<details>
<summary>Repo map</summary>

```
apps/engine          server: task feed, control, scenes, hosted demo, live mode
apps/dashboard       owner UI (Vite + React): desktop view and phone page (#/m)
apps/store           our data business: x402 route that requires a signed order
packages/contracts   shared types and zod schemas (the team agreement)
packages/control     rules, purpose check, ledger, approvals, kill switch, warrant pass
packages/agents      sourcing, support, treasury: prompts and one propose_payment tool
packages/rails       Metal and Airwallex adapters behind one interface
packages/mocks       mock Airwallex and Metal servers with fault injection, scenario feed
bench/               attack corpus, runner and scoring
docs/                architecture, decisions, demo script, runbook, testnet evidence
```

</details>

## Docs

[Architecture](docs/ARCHITECTURE.md) · [Decisions (ADRs)](docs/DECISIONS.md) ·
[Runbook](docs/RUNBOOK.md) · [Testnet evidence](docs/TESTNET.md) · [Demo script](docs/DEMO.md) ·
[Contracts](docs/CONTRACTS.md) · [Submission draft](docs/SUBMISSION.md) ·
[Video draft](docs/VIDEO.md)

Everything here is sandbox or testnet. Nothing points at production Airwallex or mainnet.
