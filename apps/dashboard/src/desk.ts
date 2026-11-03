import type { Money, PendingApproval } from "./api.js";
import { agentName, field, foldRepeats, isMoney, money } from "./format.js";
import type { Fate, Pass } from "./flow.js";
import type { SellerMoment } from "./seller.js";

/**
 * The decision desk's data (components/Desk.tsx): what waits for the owner, grouped when alike,
 * and what already happened, newest first, alike rows folded. Pure, so desk.test.ts can pin it.
 */

/** One line of what happened: a payment paid or blocked, `n` alike in a row folded into it. */
export interface PayRow {
  kind: "pay";
  key: string;
  seq: number;
  at: string;
  proposalId: string;
  fate: Exclude<Fate, "asked">;
  who: string;
  to: string;
  amount: Money;
  reason?: string;
  n: number;
}

/** A moment at our store (a warrant pass checked, a buyer refused, a dispute decided). */
export interface StoreRow {
  kind: "store";
  key: string;
  seq: number;
  at: string;
  moment: SellerMoment;
}

export type DeskRow = PayRow | StoreRow;

export type DeskFilter = "all" | "paid" | "blocked" | "store";

export const FILTERS: { id: DeskFilter; label: string }[] = [
  { id: "all", label: "Everything" },
  { id: "blocked", label: "Blocked" },
  { id: "paid", label: "Paid" },
  { id: "store", label: "At our store" },
];

/**
 * Paid and blocked payments plus store moments, newest first. Payments still waiting are left
 * out (they sit under "Needs you"). Alike payments in a row (same warrant, payee, amount, fate
 * and reason) fold into one row; `n` counts them and the row keeps the latest.
 */
export function deskRows(
  passes: Pass[],
  moments: SellerMoment[],
  nameOf: (warrantId: string) => string,
  payeeOf: (payee: string) => string,
): DeskRow[] {
  const items: DeskRow[] = [];
  for (const p of passes) {
    if (p.fate === "asked") continue;
    items.push({
      kind: "pay",
      key: `p${p.seq}`,
      seq: p.seq,
      at: p.at,
      proposalId: p.proposalId,
      fate: p.fate,
      who: nameOf(p.warrantId),
      to: payeeOf(p.payee),
      amount: p.amount,
      ...(p.reason ? { reason: p.reason } : {}),
      n: 1,
    });
  }
  for (const m of moments)
    items.push({ kind: "store", key: `s${m.seq}`, seq: m.seq, at: m.at, moment: m });
  items.sort((a, b) => a.seq - b.seq);
  return foldRepeats(items, (r) =>
    r.kind === "pay"
      ? `${r.who}|${r.to}|${r.amount.currency}${r.amount.cents}|${r.fate}|${r.reason ?? ""}`
      : r.key,
  )
    .map(({ item, n }) => (item.kind === "pay" ? { ...item, n } : item))
    .reverse();
}

export function filterRows(rows: DeskRow[], f: DeskFilter): DeskRow[] {
  if (f === "all") return rows;
  if (f === "store") return rows.filter((r) => r.kind === "store");
  return rows.filter((r) => r.kind === "pay" && r.fate === f);
}

/** Counts for the filter list; a folded row counts every payment in it. */
export function filterCounts(rows: DeskRow[]): Record<DeskFilter, number> {
  const c: Record<DeskFilter, number> = { all: 0, paid: 0, blocked: 0, store: 0 };
  for (const r of rows) {
    const n = r.kind === "pay" ? r.n : 1;
    c.all += n;
    if (r.kind === "store") c.store += 1;
    else c[r.fate] += n;
  }
  return c;
}

/**
 * The row's one sentence: "Sourcing agent paid 0.02 USDZ to Upstream data provider.", or "… asked
 * to pay … Blocked: over the per-payment cap." A list row leaves the reason to its own line.
 */
export function paySentence(r: PayRow, withReason = true): string {
  const times = r.n > 1 ? `, ${r.n} times` : "";
  return r.fate === "paid"
    ? `${r.who} paid ${money(r.amount)} to ${r.to}${times}.`
    : `${r.who} asked to pay ${money(r.amount)} to ${r.to}${times}. Blocked${withReason && r.reason ? `: ${r.reason}` : ""}.`;
}

/** Requests waiting for the owner, alike ones together (same ask, payee, amount and reasons). */
export interface AskGroup {
  key: string;
  items: PendingApproval[];
  /** "Sourcing agent → Upstream data provider", or "Treasury agent: new limits for Sourcing". */
  title: string;
  /** "0.02 USDZ", or "new limits". */
  amount: string;
  /** The first reason control gave, for the row's second line. */
  why: string;
}

export function askGroups(
  approvals: PendingApproval[],
  roleOfAgent: (agentId: string) => string | undefined = () => undefined,
): AskGroup[] {
  const out: AskGroup[] = [];
  for (const a of approvals) {
    const budget = a.view["kind"] === "budget_change";
    const role = field(a.view, "agent.role") ?? field(a.view, "warrant.role");
    const forName = agentName(typeof role === "string" ? role : undefined);
    const by = field(a.view, "proposedBy");
    const byRole = typeof by === "string" ? roleOfAgent(by) : undefined;
    const payee =
      field(a.view, "payee.displayName") ??
      (field(a.view, "payee.refundOfOrderId")
        ? `refund of ${String(field(a.view, "payee.refundOfOrderId"))}`
        : field(a.view, "payee.payeeId"));
    const amount = field(a.view, "amount");
    const title = budget
      ? byRole && byRole !== role
        ? `${agentName(byRole)} asks for new limits for the ${forName.toLowerCase()}`
        : `${forName} asks for new limits`
      : `${forName} → ${payee === undefined ? "someone" : String(payee)}`;
    const amt = budget ? "new limits" : isMoney(amount) ? money(amount) : "";
    const why = a.reasons[0] ?? "";
    const key = `${budget ? "b" : "p"}|${title}|${amt}|${a.reasons.join(";")}`;
    const same = out.find((g) => g.key === key);
    if (same) same.items.push(a);
    else out.push({ key, items: [a], title, amount: amt, why });
  }
  return out;
}
