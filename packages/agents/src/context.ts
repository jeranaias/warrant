import type { AgentRole, Currency, Money, Rail } from "@warrant/contracts";

/**
 * What an agent knows about its own world: who it is, which warrant it acts under, the payees the
 * owner named and the stored orders it may refund. Built from the engine's `GET /world`.
 *
 * Deliberately NOT here: caps, budgets or any other limit. Those are enforced in control from the
 * signed warrant; telling the model about them would only invite "stay under $X" prompt logic.
 */
export interface AgentContext {
  role: AgentRole;
  agentId: string;
  warrantId: string;
  /** Treasury: the warrant a sweep task is proposed under (ADR-022), when the world has one. */
  sweepWarrantId?: string;
  /** The owner's plain-language purpose from the signed warrant. */
  purpose: string;
  allowedRails: Rail[];
  payees: { payeeId: string; displayName: string; rail: Rail; currency: Currency }[];
  orders: { orderId: string; resource: string; price: Money }[];
}

/** The subset of the engine's `GET /world` answer the agents read. */
export interface WorldView {
  agents: Record<
    AgentRole,
    { role: AgentRole; agentId: string; warrantId: string; sweepWarrantId?: string }
  >;
  warrants: {
    warrantId: string;
    agentId: string;
    agentRole: AgentRole;
    purpose: string;
    allowedRails: Rail[];
    payees: { payeeId: string; displayName: string; rail: Rail; currency: Currency }[];
  }[];
  orders: { orderId: string; resource: string; price: Money }[];
}

export function contextFor(world: WorldView, role: AgentRole): AgentContext {
  const who = world.agents[role];
  const w = world.warrants.find((x) => x.warrantId === who.warrantId);
  if (!w) throw new Error(`world has no warrant ${who.warrantId} for ${role}`);
  const sweep = world.warrants.find((x) => x.warrantId === who.sweepWarrantId);
  return {
    role,
    agentId: who.agentId,
    warrantId: w.warrantId,
    ...(sweep ? { sweepWarrantId: sweep.warrantId } : {}),
    purpose: w.purpose,
    allowedRails: w.allowedRails,
    payees: w.payees,
    // Only support refunds orders; the others do not need to see them.
    orders: role === "support" ? world.orders : [],
  };
}
