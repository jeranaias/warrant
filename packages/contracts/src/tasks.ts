import { z } from "zod";
import { Id, Money, Timestamp } from "./common.js";
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

/** Treasury: a bill or balance to act on. */
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

export const AgentTask = z.discriminatedUnion("kind", [DataOfferTask, DisputeTask, TreasuryTask]);
export type AgentTask = z.infer<typeof AgentTask>;
