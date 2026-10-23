import { z } from "zod";
import { AgentRole, Id, Money, Rail } from "./common.js";
import { Recurrence, SpendCategory } from "./proposal.js";

/**
 * EXACTLY what the purpose checker sees, next to the signed warrant.
 * Control builds it from structured fields only. It has NO free-text field that can carry
 * attacker-controlled content: no invoice text, offer text, memo or agent justification.
 * `.strict()` makes any extra field a parse error, so nothing can be smuggled in.
 */
export const PaymentSummary = z
  .object({
    proposalId: Id,
    warrantId: Id,
    agentRole: AgentRole,
    rail: Rail,
    payee: z
      .object({
        payeeId: Id,
        /** Taken from the warrant's payee list, never from the invoice. */
        displayName: z.string().max(120),
        onAllowlist: z.boolean(),
      })
      .strict(),
    amount: Money,
    category: SpendCategory,
    recurrence: Recurrence,
    /** Change vs. the last confirmed payment to this payee, in basis points. null = first payment. */
    priceChangeBps: z.number().int().nullable(),
    spentSoFar: Money,
    budgetRemainingAfter: Money,
    paymentsToPayeeLast24h: z.number().int().nonnegative(),
  })
  .strict();
export type PaymentSummary = z.infer<typeof PaymentSummary>;
