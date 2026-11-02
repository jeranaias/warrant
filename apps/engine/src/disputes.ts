import type { DisputeCase, DisputeClaim } from "@warrant/contracts";
import { decideDispute } from "@warrant/control";
import type { Controller, DisputeFile } from "@warrant/control";
import { AGENTS, CUSTOMER_ADDRESS } from "./world.js";
import type { World } from "./world.js";

/**
 * The store answers a dispute from its own records (ADR-012 #2): the signed order, the settlement
 * on chain and the customer's warrant pass. Never from the ticket text.
 */
export async function answerDispute(
  engine: { world: World; controller: Controller; disputes?: Map<string, DisputeCase> },
  d: { disputeId: string; orderIds: string[]; claim: DisputeClaim; customer?: string | undefined },
  now = new Date(),
): Promise<DisputeFile> {
  const { world, controller } = engine;
  const dispute: DisputeCase = {
    disputeId: d.disputeId,
    customer: d.customer ?? CUSTOMER_ADDRESS,
    orderIds: d.orderIds,
    claim: d.claim,
    ticketRef: `tkt_${d.disputeId}`,
    openedAt: now.toISOString(),
  };
  // On file, so support's refunds can cover this dispute's orders and no others.
  engine.disputes?.set(dispute.ticketRef, dispute);
  return decideDispute({
    dispute,
    orders: world.orders(),
    refunded: controller.refundedOrderIds(AGENTS.support.warrantId),
    badBatches: world.badBatches,
    verifySettlement:
      world.verifySettlement ??
      (() => Promise.resolve({ ok: false, detail: "settlement check not wired in this mode" })),
    now,
  });
}
