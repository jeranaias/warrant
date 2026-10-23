# Warrant

Our entry for the Airwallex Agentic Banking Hackathon (Kit 11, x402 Business Agents).

Three AI agents run a small pay-per-call data business:

- The **sourcing agent** buys upstream data over x402 on Metal.
- The **support agent** refunds buyers.
- The **treasury agent** moves earnings into Airwallex, converts FX, pays a contractor's
  foreign-currency invoice, and proposes budget changes.
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

Status: scaffolding. The build period starts 2026-10-25.
