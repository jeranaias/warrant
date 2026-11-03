import type {
  DisputeCase,
  Money,
  RefundDecision,
  RefundReason,
  SignedOrderRecord,
} from "@warrant/contracts";
import { decodePass, verifyEvidence } from "../pass/index.js";
import type { EvidenceFinding } from "../pass/index.js";

/**
 * The store's side of a dispute (ADR-012 #2). A customer says some orders were wrong, or that
 * their agent never agreed to them. The store answers from what it kept, never from the ticket:
 * the signed order, the settlement on chain, and the customer's warrant pass. Each order gets a
 * decision in code; a refund then goes through control like any payment (support's `mandate pull`,
 * to the order's payer, at most its price).
 */

export interface DisputeInputs {
  dispute: DisputeCase;
  orders: ReadonlyMap<string, SignedOrderRecord>;
  /** Orders already refunded, or with a refund under way. */
  refunded: ReadonlySet<string>;
  /** Upstream batches known to be bad: data we sold from them was wrong. */
  badBatches: ReadonlySet<string>;
  /**
   * The settlement on chain is the sale on file (metal-pay's `verifyMandatePayment` over the
   * order's tx and signed offer). Answers why not when it isn't.
   */
  verifySettlement: (order: SignedOrderRecord) => Promise<{ ok: boolean; detail: string }>;
  now: Date;
}

export interface OrderFinding {
  orderId: string;
  decision: RefundDecision;
  /** What the evidence shows, line by line, for the customer and the dashboard. */
  evidence: EvidenceFinding[];
}

export interface DisputeFile {
  disputeId: string;
  /** The ticket the dispute came in on: a refund names it as its `sourceRef`. */
  ticketRef: string;
  findings: OrderFinding[];
  /** Total the evidence says to refund. */
  refund: Money;
}

/**
 * A decided dispute, for the event log and the dashboard: per order, the decision, whether the
 * settlement checked out, and the settlement tx. Codes and ids only, never ticket text.
 */
export interface DisputeDecidedEvent {
  type: "dispute_decided";
  disputeId: string;
  claim: DisputeCase["claim"];
  customer: string;
  /** Total the evidence says to refund (support then pays it through control). */
  refund: Money;
  orders: {
    orderId: string;
    reason: RefundReason;
    refundCents: number;
    /** The signed order and its settlement checked out. */
    verified: boolean;
    /** The order's settlement transaction, when the order is on file. */
    txHash?: string;
    /** The mandate the buyer's warrant pass names, when it names one. */
    mandateId?: string;
  }[];
}

export function disputeDecidedEvent(
  dispute: DisputeCase,
  file: DisputeFile,
  orders: ReadonlyMap<string, SignedOrderRecord>,
): DisputeDecidedEvent {
  return {
    type: "dispute_decided",
    disputeId: file.disputeId,
    claim: dispute.claim,
    customer: dispute.customer,
    refund: file.refund,
    orders: file.findings.map((f) => {
      const o = orders.get(f.orderId);
      const mandateId = decodePass(o?.buyerPass)?.grant.mandateId;
      return {
        orderId: f.orderId,
        reason: f.decision.reason,
        refundCents: f.decision.refund.cents,
        verified: f.decision.signedOrderVerified,
        ...(o ? { txHash: o.txHash } : {}),
        ...(mandateId ? { mandateId } : {}),
      };
    }),
  };
}

/**
 * The refund the store decided per order, in cents, for the orders it could verify (ADR-021).
 * Control caps a refund under this dispute's ticket at it.
 */
export function refundDecisions(file: DisputeFile): Map<string, number> {
  return new Map(
    file.findings
      .filter((f) => f.decision.signedOrderVerified)
      .map((f) => [f.orderId, f.decision.refund.cents]),
  );
}

export async function decideDispute(inp: DisputeInputs): Promise<DisputeFile> {
  const { dispute, orders } = inp;
  const findings: OrderFinding[] = [];
  const seen = new Set<string>();
  for (const orderId of dispute.orderIds) {
    if (seen.has(orderId)) continue;
    seen.add(orderId);
    findings.push(await decideOrder(inp, orderId, orders.get(orderId)));
  }
  const cents = findings.reduce((n, f) => n + f.decision.refund.cents, 0);
  return {
    disputeId: dispute.disputeId,
    ticketRef: dispute.ticketRef,
    findings,
    refund: { currency: "USDZ", cents },
  };
}

async function decideOrder(
  inp: DisputeInputs,
  orderId: string,
  order: SignedOrderRecord | undefined,
): Promise<OrderFinding> {
  const decide = (reason: RefundReason, verified: boolean, refund = 0): RefundDecision => ({
    disputeId: inp.dispute.disputeId,
    orderId,
    signedOrderVerified: verified,
    refund: { currency: order?.price.currency ?? "USDZ", cents: refund },
    reason,
    decidedAt: inp.now.toISOString(),
  });
  if (!order) {
    return { orderId, decision: decide("order_not_found", false), evidence: [] };
  }
  const evidence: EvidenceFinding[] = [];
  if (order.payer.toLowerCase() !== inp.dispute.customer.toLowerCase()) {
    evidence.push({ ok: false, what: "another account paid for this order" });
    return { orderId, decision: decide("not_customers_order", false), evidence };
  }
  const settlement = await inp.verifySettlement(order);
  evidence.push({ ok: settlement.ok, what: settlement.detail });
  evidence.push(...verifyEvidence({ order }));
  if (!settlement.ok) {
    return { orderId, decision: decide("signature_check_failed", false), evidence };
  }
  if (inp.refunded.has(orderId)) {
    return { orderId, decision: decide("already_refunded", true), evidence };
  }
  const price = order.price.cents;
  if (inp.dispute.claim === "not_authorized") {
    const authorized = evidence.every((e) => e.ok);
    return {
      orderId,
      decision: authorized
        ? decide("owner_authorized", true)
        : decide("authorization_not_proven", true, price),
      evidence,
    };
  }
  // wrong_data, not_delivered, other: we refund what came from a bad batch, and stand by the rest.
  const bad = order.upstreamBatchId !== undefined && inp.badBatches.has(order.upstreamBatchId);
  evidence.push({
    ok: !bad,
    what: bad
      ? `the data came from batch ${order.upstreamBatchId}, which was bad`
      : `the data came from batch ${order.upstreamBatchId ?? "(none recorded)"}, which was good`,
  });
  return {
    orderId,
    decision: bad ? decide("data_was_wrong", true, price) : decide("data_was_correct", true),
    evidence,
  };
}
