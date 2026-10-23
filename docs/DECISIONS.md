# Decisions (ADR log)

Append-only. New decision = new entry at the bottom. To reverse one, add a new entry that
supersedes it; don't edit the old one.

Template:

```
## ADR-NNN: <title>
Date: YYYY-MM-DD  Status: proposed | accepted | superseded by ADR-MMM
Context: what forced the decision
Decision: what we chose
Consequences: what this makes easy / hard
```

## ADR-001: TypeScript monorepo with pnpm workspaces

Date: 2026-10-23 Status: proposed

Context: Metal's SDK `@metalntwx/metal-pay` is an npm package; four people plus AI tools work in
parallel and need shared types.
Decision: pnpm workspaces, Node 24 LTS, strict TypeScript, zod schemas in `packages/contracts`,
ESLint + Prettier, Vitest. Packages export TypeScript source directly (no build step) until we
need one.
Consequences: one install, one CI job, type errors across packages show up immediately.

## ADR-002: Integer cents internally, convert only at the rail

Date: 2026-10-23 Status: proposed

Context: USDZ uses 18-decimal base units; Airwallex uses major units. Mixing them is how double
or 100x payments happen.
Decision: `Money { currency, cents }` everywhere inside the system. Conversion lives only in
`packages/rails`.
Consequences: rules and ledger never deal with decimals; rails own all unit tests for conversion.

## ADR-003: Purpose checker never sees untrusted text

Date: 2026-10-23 Status: proposed

Context: invoices and offers can carry hidden instructions.
Decision: the purpose model receives only the signed warrant and a strict `PaymentSummary` built
from structured fields.
Consequences: the purpose check can't be prompt-injected through upstream text; it also can't use
details that only exist in that text, which may raise `uncertain` verdicts.

## ADR-004: Package import boundaries enforced by ESLint

Date: 2026-10-23 Status: proposed

Decision: `no-restricted-imports` rules in `eslint.config.js` stop agents importing rails or
control, rails importing control or agents, and the dashboard importing rails or agents.

## ADR-005: Warrant signatures use RFC 8785 canonical JSON

Date: 2026-10-23 Status: accepted

Context: a signature over JSON only works if every signer and verifier serializes it the same way.
Decision: sign `WarrantBody` with ed25519 over its RFC 8785 (JSON Canonicalization Scheme)
serialization. The same canonicalization is used for `OwnerApproval.shownHash` and ledger hashes.
Consequences: one canonicalize function in control, used everywhere; field order never matters.

## ADR-006: Duplicate-payment guard window is 10 minutes

Date: 2026-10-23 Status: accepted

Decision: the `duplicate_guard` rule blocks (a) any repeat `idempotencyKey`, ever, and (b) the same
payee + same amount + same rail within 10 minutes (inclusive). It is a constant in
`packages/control/rules`, not a prompt or warrant field.
Consequences: a legitimate repeat purchase within 10 minutes needs a different amount or owner
approval. Revisit if the sourcing agent's pay-per-call pattern trips it; benign bench cases will
show that.

## ADR-007: What always needs owner approval

Date: 2026-10-23 Status: accepted

Decision: control returns `needs_owner_approval` (even when rules and purpose pass) for:

1. any `BudgetChangeProposal`;
2. the first payment to a payee (no prior confirmed payment in the ledger);
3. any `recurring` payment (subscription traps);
4. any `airwallex_transfer` or `airwallex_fx` of USD 100.00 (10000 cents) or more, inclusive;
5. any `uncertain` purpose verdict.
   Everything else that passes rules and gets `consistent` executes without asking.
   Consequences: the demo shows owner approval on treasury moves while x402 micro-payments stay
   automatic. The threshold is a code constant; changing it is a new ADR.
