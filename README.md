# Warrant

Our entry for the Airwallex Agentic Banking Hackathon (Kit 11, x402 Business Agents).

**Task board:** [Warrant hackathon project](https://github.com/users/jeranaias/projects/1) (Board, By phase, Roadmap, My work, By owner).

Three AI agents run a small pay-per-call data business:

- Customers' agents buy market data from us per query (5 cents) over x402 on Metal and sign
  each order.
- The **sourcing agent** buys upstream data (at most 3 cents per purchase).
- The **support agent** settles disputed charges by checking the stored signed orders, and refunds
  when the data we sold was wrong.
- The **treasury agent** moves earnings into Airwallex, pays a monthly licence fee invoiced in
  euros, and proposes new limits within the 20 USDZ total.
- An **Airwallex virtual card** (Kit 2) pays for a software seat.

Agents only submit typed proposals. A control layer decides:

1. **Rules check in code:** payee list, per-payment cap, total budget, expiry, duplicate-payment
   guard.
2. **Purpose check:** a separate model that sees ONLY the signed warrant and a structured payment
   summary, never raw invoice or offer text.
3. **Shared ledger:** reserve funds before money moves on any rail, then confirm or release. The
   log is append-only.

The owner signs the warrant and approves exactly what was shown; any change means asking again.
The owner also has a kill switch that revokes all warrants and freezes the card. Agents never hold
keys or card data.

**Benchmark:** 150+ attacks (fake price notices, invoices with hidden instructions, swapped
payees, subscription traps), scored against an unprotected agent, limits only, and Warrant,
including misses and false blocks.

## Layout

```
packages/contracts   shared types + zod schemas (the team agreement)
packages/control     rules check, purpose check, ledger, approvals, kill switch
packages/agents      sourcing, support, treasury: prompts + typed tools
packages/rails       Metal + Airwallex adapters behind one interface
packages/mocks       mock Airwallex + Metal servers
apps/dashboard       owner UI
bench/               attack corpus, runner, scoring
docs/                architecture, contracts, decisions, demo script, runbook
```

## Setup

See [docs/RUNBOOK.md](docs/RUNBOOK.md). Short version:

```sh
pnpm install
cp .env.example .env   # sandbox / testnet values only
pnpm verify
```

Status: build phase (shortlisted 2026-10-29). Submission due 2026-11-13; we ship 2026-11-12.
