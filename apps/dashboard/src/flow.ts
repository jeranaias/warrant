import type { LoggedEvent, Money, WarrantRow } from "./api.js";

/**
 * The gate's data (components/Gate.tsx): every payment an agent asks for, what the warrant did
 * with it, and why. Pure, so flow.test.ts can pin it.
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
  /** Why it was blocked, as a short label (REASONS); absent unless blocked. */
  reason?: string;
}

/** Short labels for the rule or check that stopped a payment. Control's ids on the left. */
export const REASONS: Record<string, string> = {
  duplicate_guard: "repeat of a recent payment",
  total_budget: "over the agent's total budget",
  per_payment_cap: "over the per-payment cap",
  payee_allowlist: "payee not on the warrant",
  rail_allowed: "rail not on the warrant",
  currency_match: "wrong currency",
  warrant_active: "warrant not active",
  warrant_expiry: "warrant expired",
  refund_matches_order: "refund doesn't match an order",
  purpose: "failed the purpose check",
  owner: "denied by you",
  rail: "the rail refused it",
  card: "declined by the card",
  malformed: "malformed request",
  stopped: "stopped",
};

/** The node for payees that are not named on any warrant: customers getting refunds. */
export const OTHER = "_customers";

export function payeeNodes(warrants: WarrantRow[]): { id: string; name: string }[] {
  const seen = new Map<string, string>();
  for (const w of warrants) for (const p of w.payees) seen.set(p.payeeId, p.displayName);
  const nodes = [...seen].map(([id, name]) => ({ id, name }));
  if (warrants.some((w) => w.payees.length === 0)) nodes.push({ id: OTHER, name: "Customers" });
  return nodes;
}

/**
 * One pass per proposal. A request that waited for the owner becomes paid or blocked once the
 * owner decides; a failed execution counts as blocked by the rail.
 */
export function passesOf(events: LoggedEvent[], warrants: WarrantRow[]): Pass[] {
  const named = new Set(warrants.flatMap((w) => w.payees.map((p) => p.payeeId)));
  const decided = new Map<string, boolean>();
  const failed = new Set<string>();
  for (const { event } of events) {
    if (event.type === "approval_decided" && event.ok)
      decided.set(event.proposalId, event.decision !== "denied");
    if (event.type === "execution" && event.execution.status === "failed")
      failed.add(event.proposalId);
  }
  const out: Pass[] = [];
  for (const { seq, at, event } of events) {
    if (event.type !== "proposal") continue;
    const p = event.proposal;
    const d = event.result.decision;
    let fate: Fate =
      d?.outcome === "execute"
        ? "paid"
        : d?.outcome === "needs_owner_approval"
          ? "asked"
          : "blocked";
    let reason: string | undefined;
    if (fate === "asked" && decided.has(p.proposalId)) {
      fate = decided.get(p.proposalId) ? "paid" : "blocked";
      if (fate === "blocked") reason = REASONS["owner"];
    }
    if (fate === "paid" && failed.has(p.proposalId)) {
      fate = "blocked";
      // The card network's own refusal (its limits mirror the warrant) reads as the card's.
      reason = REASONS[p.rail === "airwallex_card" ? "card" : "rail"];
    }
    if (fate === "blocked" && !reason) {
      const rule = d?.rules?.checks.find((c) => !c.pass)?.rule;
      const by = event.result.blockedBy;
      reason = (rule && REASONS[rule]) ?? (by && REASONS[by]) ?? rule ?? "blocked";
    }
    out.push({
      seq,
      at,
      warrantId: p.warrantId,
      payee: named.has(p.payeeId) ? p.payeeId : OTHER,
      fate,
      amount: p.amount,
      ...(reason ? { reason } : {}),
    });
  }
  return out;
}

/** Blocked passes grouped by reason, most frequent first. */
export function reasonsOf(passes: Pass[]): { reason: string; n: number }[] {
  const by = new Map<string, number>();
  for (const p of passes)
    if (p.fate === "blocked")
      by.set(p.reason ?? "blocked", (by.get(p.reason ?? "blocked") ?? 0) + 1);
  return [...by].map(([reason, n]) => ({ reason, n })).sort((a, b) => b.n - a.n);
}

/** Money paid, summed per currency, largest first. */
export function paidByCurrency(passes: Pass[]): Money[] {
  const by = new Map<Money["currency"], number>();
  for (const p of passes)
    if (p.fate === "paid")
      by.set(p.amount.currency, (by.get(p.amount.currency) ?? 0) + p.amount.cents);
  return [...by]
    .map(([currency, cents]) => ({ currency, cents }))
    .sort((a, b) => b.cents - a.cents);
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

/** Share of a budget still unspent, 0..1, for the budget meters. */
export function leftFraction(spentCents: number, budgetCents: number): number {
  if (budgetCents <= 0) return 0;
  return Math.min(1, Math.max(0, (budgetCents - spentCents) / budgetCents));
}

/**
 * Owner decisions waiting that are not payments (new limits an agent asked for). The gate adds
 * them to "Held for you" so it agrees with the WAITING count at the top.
 */
export function limitRequests(approvals: { view: Record<string, unknown> }[]): number {
  return approvals.filter((a) => a.view["kind"] === "budget_change").length;
}
