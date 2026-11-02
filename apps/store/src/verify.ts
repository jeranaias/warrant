import { createPublicClient, http } from "viem";
import type { Hash } from "viem";
import { verifyMandatePayment } from "@metalntwx/metal-pay/mandates";
import type { MandateVerification } from "@metalntwx/metal-pay/mandates";
import type { SignedOrderRecord } from "@warrant/contracts";

/**
 * The store's on-chain check of a stored sale, for disputes (ADR-012 #2): metal-pay's
 * `verifyMandatePayment` over the order's transaction and the buyer's signed order. It holds when
 * the transaction is a payment under a mandate bound on the payer's account, by the mandate's key,
 * for the signed order on file, to us, for the order's price.
 *
 * Never returns or logs the RPC URL: a node's error can carry it, so thrown errors are reduced to
 * a fixed sentence.
 */

export interface SettlementCheck {
  ok: boolean;
  /** One line for the dispute file and the dashboard. */
  detail: string;
  /** The mandate the payment was made under, when the chain shows one. */
  mandateId?: string;
}

/** USDZ has 18 decimals: 1 cent is 10^16 base units. */
const BASE_PER_CENT = 10n ** 16n;

export type VerifyPayment = (tx: Hash, signedOffer: string) => Promise<MandateVerification>;

/** `verifyMandatePayment` against the testnet node at `rpcUrl`. */
export function chainVerifier(rpcUrl: string): VerifyPayment {
  const client = createPublicClient({ transport: http(rpcUrl) });
  return (tx, signedOffer) => verifyMandatePayment(client, { tx, checkoutMandate: signedOffer });
}

const short = (h: string) => `${h.slice(0, 10)}...`;
const same = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();

/** `World.verifySettlement` for the live store. */
export function settlementVerifier(
  verify: VerifyPayment,
): (order: SignedOrderRecord) => Promise<SettlementCheck> {
  return async (order) => {
    if (!/^0x[0-9a-fA-F]{64}$/.test(order.txHash)) {
      return { ok: false, detail: "the order's transaction is not a transaction hash" };
    }
    let v: MandateVerification;
    try {
      v = await verify(order.txHash as Hash, order.signedOffer);
    } catch {
      return { ok: false, detail: `could not read ${short(order.txHash)} from the chain` };
    }
    const mandateId = v.mandate?.ref;
    const at = mandateId ? { mandateId } : {};
    const payment = v.payments.find((p) => p.kind === "payment" && same(p.txHash, order.txHash));
    const problems: string[] = [];
    if (!v.ok) {
      const failed = v.steps.find((s) => s.outcome === "fail");
      problems.push(failed ? `step ${failed.step} failed` : "the chain does not confirm it");
    }
    if (!payment) problems.push("no payment in the transaction");
    if (v.mandate && !same(v.mandate.principal, order.payer)) {
      problems.push("paid from another account than the order's payer");
    }
    if (payment && !same(payment.to, order.payee)) problems.push("paid to another account");
    if (payment && payment.amount !== BigInt(order.price.cents) * BASE_PER_CENT) {
      problems.push(`the amount is not ${order.price.cents}c`);
    }
    if (problems.length > 0) {
      return { ok: false, detail: `${short(order.txHash)}: ${problems.join("; ")}`, ...at };
    }
    return {
      ok: true,
      detail:
        `on chain: ${order.price.cents}c paid in ${short(order.txHash)} under mandate ` +
        `${mandateId ? short(mandateId) : "(unknown)"}, for the signed order on file`,
      ...at,
    };
  };
}
