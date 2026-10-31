import type { ControlEvent, LoggedEvent, Money } from "./api.js";

/**
 * Pure helpers: money, times and plain-language text for events and approval views. No React
 * here, so they are easy to test (format.test.ts) and easy to reword.
 */

/** Integer cents to a display string. No float arithmetic on money. */
export function money(m: Money | null | undefined): string {
  if (!m) return "-";
  const sign = m.cents < 0 ? "-" : "";
  const c = Math.abs(m.cents);
  const v = `${sign}${Math.floor(c / 100)}.${String(c % 100).padStart(2, "0")}`;
  return m.currency === "USDZ" ? `${v} USDZ` : `${m.currency} ${v}`;
}

export function cents(n: number | null | undefined, currency = "USDZ"): string {
  return n === null || n === undefined ? "-" : money({ currency, cents: n });
}

export function time(iso: string): string {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? iso : d.toLocaleTimeString();
}

export function isMoney(v: unknown): v is Money {
  return (
    typeof v === "object" &&
    v !== null &&
    typeof (v as Money).cents === "number" &&
    typeof (v as Money).currency === "string"
  );
}

/** Share of a budget used, 0..100, for the bar. Integer math only. */
export function percentUsed(spentCents: number, budgetCents: number): number {
  if (budgetCents <= 0) return spentCents > 0 ? 100 : 0;
  return Math.min(100, Math.floor((spentCents * 100) / budgetCents));
}

/** What we call each agent on screen. */
export const AGENT_NAMES: Record<string, string> = {
  sourcing: "Sourcing agent",
  support: "Support agent",
  treasury: "Treasury agent",
};

export function agentName(role: string | undefined): string {
  return (role ? AGENT_NAMES[role] : undefined) ?? role ?? "An agent";
}

const BLOCKED_BY: Record<string, string> = {
  rules: "the rules in its warrant",
  purpose: "the purpose check",
  owner: "you",
  rail: "the payment rail",
  malformed: "a malformed request",
};

export type Tone = "ok" | "wait" | "stop" | "owner" | "info";

export interface FeedLine {
  seq: number;
  at: string;
  tone: Tone;
  text: string;
}

/** One event from GET /events as one plain-language line for the activity feed. */
export function describe(e: LoggedEvent): FeedLine {
  const { tone, text } = describeEvent(e.event);
  return { seq: e.seq, at: e.at, tone, text };
}

function describeEvent(e: ControlEvent): { tone: Tone; text: string } {
  switch (e.type) {
    case "proposal": {
      const p = e.proposal;
      const who = agentName(p.agentRole);
      const to = p.refundOfOrderId ? `a refund on order ${p.refundOfOrderId}` : p.payeeId;
      const ask = `${who} asked to pay ${money(p.amount)} to ${to}`;
      if (e.result.blockedBy) {
        const by = BLOCKED_BY[e.result.blockedBy] ?? e.result.blockedBy;
        return { tone: "stop", text: `${ask}. Blocked by ${by}.` };
      }
      if (e.result.decision?.outcome === "needs_owner_approval") {
        return { tone: "wait", text: `${ask}. Waiting for you.` };
      }
      return { tone: "ok", text: `${ask}. Allowed.` };
    }
    case "approval_requested": {
      const why = e.pending.reasons.length ? ` (${e.pending.reasons.join("; ")})` : "";
      return { tone: "wait", text: `Needs your decision: ${e.pending.proposalId}${why}` };
    }
    case "approval_decided":
      return e.ok
        ? { tone: "owner", text: `You ${e.decision ?? "decided"}: ${e.proposalId}` }
        : {
            tone: "stop",
            text: `Your decision on ${e.proposalId} did not count (it changed or was no longer waiting).`,
          };
    case "execution": {
      const s = e.execution.status;
      if (s === "succeeded") return { tone: "ok", text: `Money moved for ${e.proposalId}.` };
      if (s === "failed") {
        const why = e.execution.detail ? `: ${e.execution.detail}` : ".";
        return { tone: "stop", text: `Payment ${e.proposalId} failed${why}` };
      }
      return {
        tone: "wait",
        text: `Payment ${e.proposalId} is not confirmed yet (${s}). Nothing is retried blind.`,
      };
    }
    case "kill_switch":
      return {
        tone: "stop",
        text: `STOP pressed. Every payment refused, mandates revoked (took ${e.result.durationMs} ms).`,
      };
    case "budget_changed":
      return {
        tone: "owner",
        text: `New limits signed for ${e.warrantId} (version ${e.fromVersion} to ${e.toVersion}).`,
      };
    default:
      return { tone: "info", text: `Event: ${(e as { type?: string }).type ?? "unknown"}` };
  }
}

/** Labels for approval-view fields. Anything not listed shows its raw key. */
export const FIELD_LABELS: Record<string, string> = {
  proposalId: "Request",
  kind: "Kind",
  "agent.agentId": "Agent id",
  "agent.role": "Agent",
  "warrant.warrantId": "Warrant",
  "warrant.version": "Warrant version",
  "warrant.agentId": "Agent id",
  "warrant.role": "Agent",
  "payee.payeeId": "Payee",
  "payee.displayName": "Payee name",
  "payee.refundOfOrderId": "Refund of order",
  routingRef: "Money goes to",
  amount: "Amount",
  rail: "Rail",
  category: "Category",
  recurrence: "Repeats",
  proposedBy: "Asked by",
  "from.perPaymentCap": "Per-payment cap now",
  "from.totalBudget": "Budget now",
  "to.perPaymentCap": "Per-payment cap new",
  "to.totalBudget": "Budget new",
};

export interface ViewRow {
  key: string;
  label: string;
  value: string;
}

/**
 * Every field of an approval view as label/value rows, nested objects flattened with dotted
 * keys. Nothing is dropped and nothing is added: the owner sees all of what they approve.
 */
export function viewRows(view: Record<string, unknown>, prefix = ""): ViewRow[] {
  const rows: ViewRow[] = [];
  for (const [k, v] of Object.entries(view)) {
    const key = prefix ? `${prefix}.${k}` : k;
    if (v !== null && typeof v === "object" && !isMoney(v) && !Array.isArray(v)) {
      rows.push(...viewRows(v as Record<string, unknown>, key));
    } else {
      rows.push({ key, label: FIELD_LABELS[key] ?? key, value: show(v) });
    }
  }
  return rows;
}

function show(v: unknown): string {
  if (v === null || v === undefined) return "-";
  if (isMoney(v)) return money(v);
  if (Array.isArray(v)) return v.map(show).join(", ");
  return String(v);
}
