import { z } from "zod";
import { Id, Timestamp } from "./common.js";

export const RuleName = z.enum([
  "warrant_active", // signature valid, not revoked, kill switch not engaged
  "warrant_expiry", // notBefore <= now <= expiresAt (inclusive)
  "rail_allowed",
  "payee_allowlist",
  "currency_match",
  "per_payment_cap", // amount <= cap (inclusive)
  "total_budget", // confirmed + reserved + amount <= budget (inclusive)
  "duplicate_guard", // same idempotencyKey, or same payee+amount inside the window
  "refund_matches_order", // refunds: order exists, payee = its payer, amount <= its price, not refunded
]);
export type RuleName = z.infer<typeof RuleName>;

export const RuleCheck = z
  .object({ rule: RuleName, pass: z.boolean(), detail: z.string().max(500) })
  .strict();
export type RuleCheck = z.infer<typeof RuleCheck>;

/** Deterministic, in code. `pass` is true only if every check passed. */
export const RulesResult = z
  .object({
    proposalId: Id,
    pass: z.boolean(),
    checks: z.array(RuleCheck).min(1),
    evaluatedAt: Timestamp,
  })
  .strict();
export type RulesResult = z.infer<typeof RulesResult>;

export const PurposeReason = z.enum([
  "matches_warrant_purpose",
  "outside_warrant_purpose",
  "unexpected_price_change",
  "unexpected_recurrence",
  "unusual_frequency",
  "category_mismatch",
  "insufficient_information",
]);
export type PurposeReason = z.infer<typeof PurposeReason>;

/** Output of the separate purpose-check model. Anything but `consistent` blocks or escalates. */
export const PurposeVerdict = z
  .object({
    proposalId: Id,
    verdict: z.enum(["consistent", "inconsistent", "uncertain"]),
    reasons: z.array(PurposeReason).min(1),
    explanation: z.string().max(500),
    model: z.string().min(1),
    evaluatedAt: Timestamp,
  })
  .strict();
export type PurposeVerdict = z.infer<typeof PurposeVerdict>;

/** Control's final decision on a proposal. Purpose is null when rules already blocked it. */
export const ControlDecision = z
  .object({
    proposalId: Id,
    outcome: z.enum(["execute", "needs_owner_approval", "blocked"]),
    rules: RulesResult,
    purpose: PurposeVerdict.nullable(),
    decidedAt: Timestamp,
  })
  .strict();
export type ControlDecision = z.infer<typeof ControlDecision>;
