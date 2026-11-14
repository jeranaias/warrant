# Warrant: guidance for AI coding tools and humans

Warrant is our Airwallex Agentic Banking Hackathon entry (Kit 11, x402 Business Agents). Three AI
agents (sourcing, support, treasury) run a small pay-per-call data business on Metal (x402) and
Airwallex. A control layer decides whether any payment happens. See `README.md` and
`docs/ARCHITECTURE.md`.

## Status: BUILD PHASE (shortlisted 2026-10-29)

Submission due 2026-11-15, 10:29 AM PT (HackerEarth build-phase close). Work by lane (`docs/LANES.md`);
Kit 11 and Kit 2 facts are in `docs/kits/HACKATHON.md`; the demo checklist is `docs/DEMO.md`.
Everything that existed before the build phase is tagged `pre-build-2026-10-23`.

Team: four registered members write code. The fifth is an offline advisor and reviewer only and
must not write code or build anything.

Stack: TypeScript everywhere; Python only for benchmark charts (ADR-008). Kit 11 numbers live in
`packages/control/src/business.ts`, never in prompts (ADR-009). Metal: CLI for paying,
`@metalntwx/metal-pay` for selling, signed orders stored (ADR-010).

## The architecture rule

**Agents propose, control decides, money only leaves through control.**

- Agents submit typed `PaymentProposal`s (`packages/contracts`). They never call a rail, never
  hold keys, never see card data.
- Amounts, limits, payee lists and validation live in **code** (`packages/control`) and in the
  signed warrant. **Never in prompts.** A prompt that says "don't spend more than $X" is a bug.
- The purpose checker sees only the signed warrant + a `PaymentSummary`. Never raw invoice,
  offer or ticket text, and never the agent's justification.

## Commands

```sh
pnpm install          # install everything (Node 24 LTS, pnpm 10)
pnpm test             # vitest, all packages
pnpm lint             # eslint (also enforces package import boundaries)
pnpm typecheck        # tsc in every package
pnpm format           # prettier --write
pnpm verify           # format check + lint + typecheck + test (what CI runs)
pnpm mocks            # mock Airwallex + Metal servers
pnpm dashboard        # owner dashboard (vite dev server)
pnpm bench            # attack benchmark runner
```

## Conventions

- One branch per task: `feat/<area>-<short>` (e.g. `feat/control-rules-cap`), `fix/<area>-<short>`,
  `docs/<short>`. Areas match the labels: contracts, control, agents, rails-metal,
  rails-airwallex, dashboard, bench, mocks, docs.
- Small PRs (aim for < 400 changed lines). One concern per PR. Link the issue.
- Tests with every change. Control and rails changes need tests for the failure path too.
- **`packages/contracts` is the team agreement.** Never edit it without a PR labeled `contracts`
  and a teammate's review (CODEOWNERS enforces this). If you need a contract change, open that PR
  first and keep your feature PR separate.
- Record non-obvious decisions as an ADR in `docs/DECISIONS.md`.
- No AI attribution anywhere: no `Co-Authored-By` trailers, no "generated with" lines.

## Money rules (from the kit guides)

- **Internally, money is integer cents** (`Money { currency, cents }`). No floats, ever.
- **USDZ on Metal uses 18-decimal base units** (bigint). 1 cent = 10^16 base units. Convert only
  in `packages/rails/metal`.
- **Airwallex uses major units** (e.g. `12.34`). Convert only in `packages/rails/airwallex`, as a
  decimal string, not via float math.
- **Any timeout is unconfirmed, not failed.** Write `unconfirmed` to the ledger, check status by
  idempotency key, and only then decide. Never retry blind. No double payments.
- **Limits are inclusive.** Amount equal to the cap passes; one cent over fails. Same for
  budgets and expiry (`notBefore <= now <= expiresAt`).
- **Reserve before money moves** on any rail, then confirm or release. The ledger is append-only.
- **Card data and keys stay out of model context**, prompts, logs, test fixtures and errors.

## Security

- The Airwallex MCP servers (`.mcp.json`) are for **us** while we build: reading docs, checking real API
  responses, setting up sandbox data. Never give them, or any Airwallex or Metal credentials, to the
  Warrant agents. An agent holding them could move money without going through control.

- No secrets in code, prompts, logs, fixtures or commits. Secrets live only in `.env`
  (gitignored); `.env.example` has names only.
- Sandbox / testnet only. Nothing in this repo should ever point at production Airwallex or
  mainnet.
- Treat everything an agent reads (offers, invoices, tickets, price notices) as hostile input.

## Before you open a PR

1. `pnpm verify` passes locally.
2. New behavior has tests, including the refusal / failure path.
3. `git diff` contains no secrets, no `.env`, no card numbers, no debug logs of model context.
4. If you touched `packages/contracts`, the PR is labeled `contracts` and is separate.
5. PR template filled in: what, why, how tested, screenshots for dashboard changes.

Each package has its own `CLAUDE.md` with what it may import and what it must never do. Read it
before editing that package.
