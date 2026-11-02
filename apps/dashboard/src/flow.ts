import type { LoggedEvent, Money, WarrantRow } from "./api.js";

/**
 * The rings' data (components/Rings.tsx): every payment an agent asks for, and what the
 * warrant did with it. Pure, so flow.test.ts can pin it.
 */

/** What happened at the seal: money moved, control said no, or it is waiting for the owner. */
export type Fate = "paid" | "blocked" | "asked";

export interface Pass {
  seq: number;
  at: string;
  warrantId: string;
  /** The payee node it flows to; OTHER for a payee on no warrant (refunds to customers). */
  payee: string;
  fate: Fate;
  amount: Money;
}

/** The node for payees that are not named on any warrant: customers getting refunds. */
export const OTHER = "_customers";

export function payeeNodes(warrants: WarrantRow[]): { id: string; name: string }[] {
  const seen = new Map<string, string>();
  for (const w of warrants) for (const p of w.payees) seen.set(p.payeeId, p.displayName);
  const nodes = [...seen].map(([id, name]) => ({ id, name }));
  if (warrants.some((w) => w.payees.length === 0)) nodes.push({ id: OTHER, name: "Customers" });
  return nodes;
}

export function passesOf(events: LoggedEvent[], warrants: WarrantRow[]): Pass[] {
  const named = new Set(warrants.flatMap((w) => w.payees.map((p) => p.payeeId)));
  const out: Pass[] = [];
  for (const { seq, at, event } of events) {
    if (event.type !== "proposal") continue;
    const p = event.proposal;
    const outcome = event.result.decision?.outcome;
    out.push({
      seq,
      at,
      warrantId: p.warrantId,
      payee: named.has(p.payeeId) ? p.payeeId : OTHER,
      fate:
        outcome === "execute" ? "paid" : outcome === "needs_owner_approval" ? "asked" : "blocked",
      amount: p.amount,
    });
  }
  return out;
}

export interface Tally {
  paid: number;
  blocked: number;
  asked: number;
}

/** Counts per agent lane, per payee, and in total. Money paid per payee, in its currency. */
export function tally(passes: Pass[]) {
  const total: Tally = { paid: 0, blocked: 0, asked: 0 };
  const lanes = new Map<string, Tally>();
  const paidTo = new Map<string, Money>();
  for (const p of passes) {
    total[p.fate] += 1;
    const lane = lanes.get(p.warrantId) ?? { paid: 0, blocked: 0, asked: 0 };
    lane[p.fate] += 1;
    lanes.set(p.warrantId, lane);
    if (p.fate === "paid") {
      const was = paidTo.get(p.payee);
      paidTo.set(p.payee, {
        currency: p.amount.currency,
        cents: (was?.currency === p.amount.currency ? was.cents : 0) + p.amount.cents,
      });
    }
  }
  return { total, lanes, paidTo };
}

/** Share of a budget still unspent, 0..1, for the agent rings. */
export function leftFraction(spentCents: number, budgetCents: number): number {
  if (budgetCents <= 0) return 0;
  return Math.min(1, Math.max(0, (budgetCents - spentCents) / budgetCents));
}
