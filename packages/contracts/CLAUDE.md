# packages/contracts

**Purpose:** shared types and zod schemas. This is the team agreement every other package codes
against: Warrant, PaymentProposal, PaymentSummary, RulesResult, PurposeVerdict, ControlDecision,
OwnerApproval, LedgerEntry, Rail, KillSwitchEvent, Money.

**May import:** `zod` only.

**Must never:**

- Be edited without a PR labeled `contracts` and a teammate's review (CODEOWNERS).
- Contain logic beyond schema validation (no I/O, no rails, no model calls).
- Add a free-text field to `PaymentSummary`. Its whole point is that attacker-controlled text
  cannot reach the purpose checker.
- Represent money as a float or in major units. `Money.cents` is an integer.
- Loosen `.strict()` on any schema.

Changing a schema: update `docs/CONTRACTS.md` and the tests in the same PR.
