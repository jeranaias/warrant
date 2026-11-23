import type { LoggedEvent, Money } from "./api.js";
import { cents, money, short } from "./format.js";

/**
 * The seller's side (our store): each buyer's warrant pass it checked, and each dispute it
 * answered from its records. Pure, for the store card on the desktop and the phone.
 */

export interface SellerRow {
  label: string;
  value: string;
  mono?: boolean;
}

export interface SellerMoment {
  seq: number;
  at: string;
  kind: "pass" | "dispute";
  ok: boolean;
  title: string;
  /** One short line under the title. */
  summary: string;
  rows: SellerRow[];
}

const words = (code: string) => code.replaceAll("_", " ");

function capLine(cap: Money, priceCents: number): string {
  return `${money(cap)} cap · price ${cents(priceCents, cap.currency)}`;
}

export function sellerMoments(events: readonly LoggedEvent[]): SellerMoment[] {
  const out: SellerMoment[] = [];
  for (const l of events) {
    const e = l.event;
    if (e.type === "pass_checked") {
      const b = e.buyer;
      if (e.ok && b) {
        out.push({
          seq: l.seq,
          at: l.at,
          kind: "pass",
          ok: true,
          title: "Buyer's warrant pass checked",
          summary: "Served: an owner signed for this purchase.",
          rows: [
            { label: "Signed by", value: `owner ${b.ownerId} · key ${b.ownerKey.slice(0, 8)}` },
            ...(b.mandateId ? [{ label: "Mandate", value: short(b.mandateId), mono: true }] : []),
            { label: "Limit", value: capLine(b.perPaymentCap, e.amountCents) },
          ],
        });
      } else {
        out.push({
          seq: l.seq,
          at: l.at,
          kind: "pass",
          ok: false,
          title: "Buyer refused at the store",
          summary: "Not served, not charged.",
          rows: e.problems.map((p) => ({ label: "Why", value: p })),
        });
      }
    } else if (e.type === "dispute_decided") {
      const refunded = e.orders.filter((o) => o.refundCents > 0).length;
      const n = e.orders.length;
      out.push({
        seq: l.seq,
        at: l.at,
        kind: "dispute",
        ok: true,
        title: `Dispute · ${words(e.claim)}`,
        summary:
          `${n} order${n === 1 ? "" : "s"} · refund ${refunded} · kept ${n - refunded}` +
          (e.refund.cents > 0 ? ` · ${money(e.refund)} back to the payer` : ""),
        rows: [
          ...e.orders.map((o) => ({
            label: o.orderId,
            value:
              (o.refundCents > 0 ? `refund ${cents(o.refundCents, e.refund.currency)}` : "kept") +
              ` · ${words(o.reason)}` +
              (o.verified && o.txHash ? ` · on chain ${short(o.txHash)}` : ""),
          })),
          { label: "Dispute", value: e.disputeId, mono: true },
        ],
      });
    }
  }
  return out;
}
