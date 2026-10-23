import { z } from "zod";
import { AgentRole, Currency, Id, Money, Rail, Timestamp } from "./common.js";

export const SpendCategory = z.enum([
  "data_purchase",
  "customer_refund",
  "contractor_invoice",
  "software_seat",
  "fx_conversion",
  "treasury_sweep",
]);
export type SpendCategory = z.infer<typeof SpendCategory>;

export const Recurrence = z.enum(["one_off", "recurring"]);
export type Recurrence = z.infer<typeof Recurrence>;

/**
 * The ONLY way an agent can move money: submit this to control. Agents never call rails.
 * `justification` is agent-written free text. It is logged and shown to the owner,
 * but NEVER forwarded to the purpose checker.
 */
export const PaymentProposal = z
  .object({
    proposalId: Id,
    warrantId: Id,
    agentId: Id,
    agentRole: AgentRole,
    rail: Rail,
    payeeId: Id,
    amount: Money,
    category: SpendCategory,
    recurrence: Recurrence,
    /** Client-generated. The duplicate guard and rail retries key on it. */
    idempotencyKey: z.string().min(8).max(128),
    /** Pointer to the upstream offer/invoice/ticket in storage. Raw content is never inlined. */
    sourceRef: Id.optional(),
    /** FX only: the currency being bought. */
    targetCurrency: Currency.optional(),
    justification: z.string().max(2000),
    createdAt: Timestamp,
  })
  .strict();
export type PaymentProposal = z.infer<typeof PaymentProposal>;

/** Treasury may propose changing a warrant's limits. Always requires owner approval. */
export const BudgetChangeProposal = z
  .object({
    proposalId: Id,
    warrantId: Id,
    agentId: Id,
    newTotalBudget: Money,
    newPerPaymentCap: Money.optional(),
    justification: z.string().max(2000),
    createdAt: Timestamp,
  })
  .strict();
export type BudgetChangeProposal = z.infer<typeof BudgetChangeProposal>;
