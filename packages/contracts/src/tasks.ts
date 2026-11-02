import { z } from "zod";
import { AgentRole, Id, Money, Timestamp } from "./common.js";
import { DisputeClaim } from "./orders.js";

/**
 * One piece of work the world hands an agent. `apps/engine` serves these (`GET /tasks`); lane A's
 * runner gives each to the matching agent, which answers with zero or more `PaymentProposal`s.
 *
 * `content` is the raw text the agent reads (an offer, an invoice, a support ticket). It is
 * UNTRUSTED and may carry an attack. It goes to the agent's model only, never to the purpose
 * checker (ADR-003); proposals point back to it with `sourceRef`.
 */
const base = {
  taskId: Id,
  at: Timestamp,
  /** Pass through as the proposal's `sourceRef`. */
  sourceRef: Id,
  content: z.string().max(4000),
};

/** Sourcing: an upstream provider offers data at a price. */
export const DataOfferTask = z
  .object({
    ...base,
    kind: z.literal("data_offer"),
    role: z.literal("sourcing"),
    /** The payee the offer claims to come from. May not be on the warrant (that's an attack). */
    payeeId: Id,
    item: z.string().min(1).max(200),
    price: Money,
  })
  .strict();
export type DataOfferTask = z.infer<typeof DataOfferTask>;

/** Support: a customer disputes one or more of our stored orders. */
export const DisputeTask = z
  .object({
    ...base,
    kind: z.literal("dispute"),
    role: z.literal("support"),
    disputeId: Id,
    orderIds: z.array(Id).min(1).max(500),
    claim: DisputeClaim,
  })
  .strict();
export type DisputeTask = z.infer<typeof DisputeTask>;

/** Treasury: a bill to pay (the licence fee, a software seat). */
export const TreasuryTask = z
  .object({
    ...base,
    kind: z.literal("invoice"),
    role: z.literal("treasury"),
    payeeId: Id,
    amount: Money,
    recurrence: z.enum(["one_off", "recurring"]),
  })
  .strict();
export type TreasuryTask = z.infer<typeof TreasuryTask>;

/**
 * Treasury: earnings sit in the business's Metal account; move them toward Airwallex (Kit 11).
 * The answer is one `treasury_sweep` proposal to `payeeId`, our own Metal address on the warrant;
 * rails then record the simulated Airwallex deposit with the tx hash (ADR-010 item 4).
 * `available` is read by the engine from the ledger, never from `content`.
 */
export const SweepTask = z
  .object({
    ...base,
    kind: z.literal("sweep"),
    role: z.literal("treasury"),
    payeeId: Id,
    available: Money,
  })
  .strict();
export type SweepTask = z.infer<typeof SweepTask>;

/** One agent's current limits and spend, as control's ledger and the signed warrant say. */
export const AgentSpend = z
  .object({
    role: AgentRole,
    warrantId: Id,
    perPaymentCap: Money,
    totalBudget: Money,
    spent: Money,
  })
  .strict();
export type AgentSpend = z.infer<typeof AgentSpend>;

/**
 * Treasury: how spending stands against the limits, so treasury can propose new ones (Kit 11:
 * "treasury proposes new limits within the 20 USDZ total"). The answer is zero or more
 * `BudgetChangeProposal`s, which always wait for the owner (ADR-007). The numbers are data from
 * control, not instructions: control re-checks any proposal against `totalLimit` and spend.
 */
export const SpendReviewTask = z
  .object({
    ...base,
    kind: z.literal("spend_review"),
    role: z.literal("treasury"),
    agents: z.array(AgentSpend).min(1).max(3),
    /** The total all agents' budgets must stay within. */
    totalLimit: Money,
    /** The upstream price now, when it is why sourcing is being refused. */
    upstreamPrice: Money.optional(),
  })
  .strict();
export type SpendReviewTask = z.infer<typeof SpendReviewTask>;

export const AgentTask = z.discriminatedUnion("kind", [
  DataOfferTask,
  DisputeTask,
  TreasuryTask,
  SweepTask,
  SpendReviewTask,
]);
export type AgentTask = z.infer<typeof AgentTask>;
