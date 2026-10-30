import { z } from "zod";
import { Id, Money, Timestamp } from "./common.js";

const Sha256Hex = z.string().regex(/^[0-9a-f]{64}$/);
const Address = z.string().regex(/^0x[0-9a-fA-F]{40}$/);
const TxHash = z.string().regex(/^0x[0-9a-fA-F]{64}$/);

/**
 * One sale on our store, kept as proof (Kit 11: "nothing stores them for you").
 * Written once in `onAfterSettle` when the settlement is the first for this payment; never edited.
 * A dispute is checked with `verifyMandatePayment({ tx: txHash, checkoutMandate: signedOffer })`.
 */
export const SignedOrderRecord = z
  .object({
    orderId: Id,
    /** The route's `resource`, e.g. "GET /query/fx-eurusd". One route per item. */
    resource: z.string().min(1).max(200),
    price: Money,
    /** Our store's address (payTo). */
    payee: Address,
    /** The customer's smart account that paid. Refunds go here and nowhere else. */
    payer: Address,
    network: z.enum(["eip155:63825"]),
    txHash: TxHash,
    /** Facilitator settlement id. */
    settlementId: z.string().min(1).max(256),
    /** `signedOfferOf(paymentPayload)` as JSON text. Opaque to us; verified by metal-pay. */
    signedOffer: z.string().min(1).max(20_000),
    /** sha256 of the exact response body we delivered. */
    deliveredSha256: Sha256Hex,
    /** Upstream batch the delivered data came from, so a bad batch can be traced. */
    upstreamBatchId: Id.optional(),
    /**
     * The buyer's warrant pass (`x-warrant-pass`, base64url) as received, checked before we
     * served (ADR-012). Dispute evidence: shows whose owner authorized the purchase.
     */
    buyerPass: z.string().min(1).max(20_000).optional(),
    at: Timestamp,
  })
  .strict();
export type SignedOrderRecord = z.infer<typeof SignedOrderRecord>;

export const DisputeClaim = z.enum(["wrong_data", "not_delivered", "not_authorized", "other"]);
export type DisputeClaim = z.infer<typeof DisputeClaim>;

/**
 * A customer's dispute over a batch of charges. The ticket's text is untrusted and stays in
 * storage behind `ticketRef`; it never reaches the purpose checker.
 */
export const DisputeCase = z
  .object({
    disputeId: Id,
    customer: Address,
    orderIds: z.array(Id).min(1).max(500),
    claim: DisputeClaim,
    ticketRef: Id,
    openedAt: Timestamp,
  })
  .strict();
export type DisputeCase = z.infer<typeof DisputeCase>;

export const RefundReason = z.enum([
  "data_was_wrong", // delivered data came from a batch known to be bad
  "data_was_correct",
  "signature_check_failed", // verifyMandatePayment failed: not our sale as claimed
  "not_customers_order", // the order's payer is not the disputing customer
  "already_refunded",
  "order_not_found",
]);
export type RefundReason = z.infer<typeof RefundReason>;

/** Per-order outcome of a dispute. Decided in code from stored orders, not by a model. */
export const RefundDecision = z
  .object({
    disputeId: Id,
    orderId: Id,
    signedOrderVerified: z.boolean(),
    refund: Money,
    reason: RefundReason,
    decidedAt: Timestamp,
  })
  .strict();
export type RefundDecision = z.infer<typeof RefundDecision>;
