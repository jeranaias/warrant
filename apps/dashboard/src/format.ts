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

export function cents(n: number | null | undefined, currency: Money["currency"] = "USDZ"): string {
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

/**
 * A warrant's short name on the gate: "Treasury", or "Treasury card" for a warrant that pays only
 * by card, so an agent with two warrants shows two distinct lanes.
 */
export function laneName(w: { agentRole: string; allowedRails: string[] }): string {
  const name = agentName(w.agentRole).replace(/ agent$/, "");
  const cardOnly = w.allowedRails.length > 0 && w.allowedRails.every((r) => r === "airwallex_card");
  return cardOnly ? `${name} card` : name;
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
  /** Why it was blocked or held: the rule that failed or the purpose check's words. */
  why?: string;
}

/** What the feed needs to name things instead of showing ids. Every lookup may miss. */
export interface Names {
  /** A warrant id to its agent's role. */
  role: (warrantId: string) => string | undefined;
  /** A payee id to its display name. */
  payee: (payeeId: string) => string | undefined;
  /** A request id to what it asks: "new limits for the Sourcing agent". */
  request: (proposalId: string) => string | undefined;
}

const NO_NAMES: Names = { role: () => undefined, payee: () => undefined, request: () => undefined };

/** What an approval view asks, in a few words: "new limits for the Sourcing agent". */
export function subjectOf(view: Record<string, unknown>): string {
  const role = field(view, "agent.role") ?? field(view, "warrant.role");
  const who = agentName(typeof role === "string" ? role : undefined);
  if (view["kind"] === "budget_change") return `new limits for the ${who}`;
  const amount = field(view, "amount");
  const payee = field(view, "payee.displayName");
  const to = typeof payee === "string" ? ` to ${payee}` : "";
  return `${isMoney(amount) ? money(amount) : "a payment"} from the ${who}${to}`;
}

/** Names for the feed, from the warrants and what the events themselves say. */
export function namesOf(
  events: LoggedEvent[],
  warrants: {
    warrantId: string;
    agentRole: string;
    payees: { payeeId: string; displayName: string }[];
  }[],
): Names {
  const payees = new Map<string, string>();
  for (const w of warrants) for (const p of w.payees) payees.set(p.payeeId, p.displayName);
  const roles = new Map(warrants.map((w) => [w.warrantId, w.agentRole]));
  const requests = new Map<string, string>();
  for (const { event: e } of events) {
    if (e.type === "proposal") {
      const p = e.proposal;
      const to = payees.get(p.payeeId);
      requests.set(
        p.proposalId,
        `${money(p.amount)} from the ${agentName(p.agentRole)}${to ? ` to ${to}` : ""}`,
      );
    } else if (e.type === "approval_requested") {
      requests.set(e.pending.proposalId, subjectOf(e.pending.view));
    }
  }
  return {
    role: (id) => roles.get(id),
    payee: (id) => payees.get(id),
    request: (id) => requests.get(id),
  };
}

/** One event from GET /events as one plain-language line for the activity feed. */
export function describe(e: LoggedEvent, names: Names = NO_NAMES): FeedLine {
  const d = describeEvent(e.event, names);
  const why = d.why ?? whyOf(e.event);
  return { seq: e.seq, at: e.at, tone: d.tone, text: d.text, ...(why ? { why } : {}) };
}

/** A hash or id cut to its first 10 characters, e.g. "0x6908b0a2...". */
export function short(h: string): string {
  return h.length > 13 ? `${h.slice(0, 10)}...` : h;
}

const words = (code: string) => code.replaceAll("_", " ");

function pathOf(url: string): string {
  try {
    return new URL(url).pathname;
  } catch {
    return url;
  }
}

/** Short state word for a feed line's pill. */
export const TONE_WORDS: Record<Tone, string> = {
  ok: "allowed",
  wait: "waiting",
  stop: "blocked",
  owner: "you",
  info: "note",
};

/** The reason behind a block or a hold, in control's own words. Never the agent's text. */
export function whyOf(e: ControlEvent): string | undefined {
  if (e.type !== "proposal" || !e.result.decision) return undefined;
  const d = e.result.decision;
  const failed = d.rules?.checks.filter((c) => !c.pass).map((c) => c.detail) ?? [];
  if (failed.length) return failed.join("; ");
  if (d.outcome !== "execute" && d.purpose?.explanation) return d.purpose.explanation;
  return undefined;
}

/** "Approve EUR 50.00": the button repeats the amount, so the thumb confirms the number. */
export function approveLabel(view: Record<string, unknown>): string {
  const amount = view["amount"];
  return isMoney(amount) ? `Approve ${money(amount)}` : "Approve";
}

/** A dotted field of an approval view, e.g. field(view, "payee.displayName"). */
export function field(view: Record<string, unknown>, path: string): unknown {
  let v: unknown = view;
  for (const k of path.split(".")) {
    if (v === null || typeof v !== "object") return undefined;
    v = (v as Record<string, unknown>)[k];
  }
  return v;
}

const frozen = (ids: string[] | undefined) =>
  ids?.length ? `, ${ids.length} ${ids.length === 1 ? "card" : "cards"} frozen` : "";

function describeEvent(e: ControlEvent, names: Names): { tone: Tone; text: string; why?: string } {
  const what = (id: string) => names.request(id) ?? id;
  switch (e.type) {
    case "proposal": {
      const p = e.proposal;
      const who = agentName(p.agentRole);
      const to = p.refundOfOrderId
        ? `a refund on order ${p.refundOfOrderId}`
        : (names.payee(p.payeeId) ?? p.payeeId);
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
      return { tone: "wait", text: `Needs your decision: ${subjectOf(e.pending.view)}${why}` };
    }
    case "approval_decided":
      return e.ok
        ? { tone: "owner", text: `You ${e.decision ?? "decided"} ${what(e.proposalId)}.` }
        : {
            tone: "stop",
            text: `Your decision on ${what(e.proposalId)} did not count (it changed or was no longer waiting).`,
          };
    case "execution": {
      const s = e.execution.status;
      if (s === "succeeded") return { tone: "ok", text: `Money moved: ${what(e.proposalId)}.` };
      if (s === "failed") {
        const why = e.execution.detail ? `: ${e.execution.detail}` : ".";
        return { tone: "stop", text: `Payment of ${what(e.proposalId)} failed${why}` };
      }
      return {
        tone: "wait",
        text: `Payment of ${what(e.proposalId)} is not confirmed yet (${s}). Nothing is retried blind.`,
      };
    }
    case "kill_switch":
      return {
        tone: "stop",
        text: `STOP pressed. Every payment refused, mandates revoked${frozen(e.result.event.frozenCardIds)} (took ${e.result.durationMs} ms).`,
      };
    case "budget_changed": {
      const role = names.role(e.warrantId);
      const whose = role ? `the ${agentName(role)}` : e.warrantId;
      return { tone: "owner", text: `You signed new limits for ${whose} (v${e.toVersion}).` };
    }
    case "pass_checked": {
      const b = e.buyer;
      const what = pathOf(e.url);
      if (!e.ok) {
        const who = b ? `from ${short(b.payer)}` : "with no readable pass";
        return {
          tone: "stop",
          text: `Store refused a buyer's warrant pass for ${what} (${who}). Not served, not charged.`,
          why: e.problems.join("; "),
        };
      }
      const mandate = b?.mandateId ? `, mandate ${short(b.mandateId)}` : "";
      const signed = b ? `signed by the owner ${b.ownerId} (key ${b.ownerKey.slice(0, 8)})` : "";
      const cap = b ? `, cap ${money(b.perPaymentCap)}` : "";
      return {
        tone: "ok",
        text: `Store checked the buyer's warrant pass for ${what}: ${signed}${mandate}${cap}.`,
      };
    }
    case "dispute_decided": {
      const refunded = e.orders.filter((o) => o.refundCents > 0);
      const kept = e.orders.length - refunded.length;
      const n = e.orders.length;
      const lines = e.orders.map((o) => {
        const chain = o.verified && o.txHash ? `, on chain ${short(o.txHash)}` : "";
        const outcome =
          o.refundCents > 0 ? `refund ${cents(o.refundCents, e.refund.currency)}` : "kept";
        return `${o.orderId}: ${outcome} (${words(o.reason)}${chain})`;
      });
      return {
        tone: "info",
        text:
          `Dispute ${e.disputeId} (${words(e.claim)}): ${n} order${n === 1 ? "" : "s"}, ` +
          `refund ${refunded.length}, kept ${kept}.`,
        why: lines.join("; "),
      };
    }
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

/** `bench/results.json`, the committed benchmark headline (`pnpm bench` rewrites it). */
export interface BenchHeadline {
  attacks: number;
  benign: number;
  modes: Record<string, { attacksBlocked: number; falseBlocks: number } | undefined>;
}

/**
 * One line of benchmark facts for the gate page, or null when the file lacks a number:
 * "Benchmark: blocks 141 of 152 attacks · limits alone 98 · 1 of 31 normal payments held".
 */
export function benchLine(h: BenchHeadline | null | undefined): string | null {
  const w = h?.modes["warrant"];
  const l = h?.modes["limits_only"];
  if (!h || !w || !l) return null;
  return (
    `Benchmark: blocks ${w.attacksBlocked} of ${h.attacks} attacks · ` +
    `limits alone ${l.attacksBlocked} · ` +
    `${w.falseBlocks} of ${h.benign} normal payments held`
  );
}

/** Plain names for the engine's scenario ids, and one line on what each does. */
export const SCENARIOS: Record<string, { label: string; what: string }> = {
  normal: { label: "Normal day", what: "Routine data purchases and the monthly licence fee." },
  price_rise: {
    label: "Supplier raises the price",
    what: "The data supplier raises its price above the sourcing agent's cap.",
  },
  dispute: {
    label: "Customer disputes a charge",
    what: "A customer says the data was wrong and asks for a refund.",
  },
  attacks: {
    label: "Attacks on the agents",
    what: "A changed payment address, hidden instructions, a fake invoice, refund fraud.",
  },
  all: { label: "Everything", what: "Every scenario in one run." },
};

export function scenarioLabel(id: string): string {
  return SCENARIOS[id]?.label ?? id;
}

/** A mandate credential file ("sourcing.json", "sourcing-v2.json") as "Sourcing agent · v2". */
export function mandateName(credential: string): string {
  const m = /^([a-z]+)(?:-v(\d+))?\.json$/.exec(credential);
  if (!m?.[1] || !AGENT_NAMES[m[1]]) return credential;
  return `${agentName(m[1])} · v${m[2] ?? "1"}`;
}

/**
 * The owner's latest action after event `afterSeq`, as one line for the bottom bar, or null:
 * "You signed new limits for the Sourcing agent."
 */
export function ownerLine(
  events: LoggedEvent[],
  roleOf: (warrantId: string) => string | undefined,
  afterSeq: number,
): string | null {
  for (let i = events.length - 1; i >= 0; i--) {
    const le = events[i];
    if (!le || le.seq <= afterSeq) return null;
    const e = le.event;
    if (e.type === "budget_changed")
      return `You signed new limits for the ${agentName(roleOf(e.warrantId))}.`;
    if (e.type === "approval_decided" && e.ok) {
      const asked = events.find(
        (x) => x.event.type === "proposal" && x.event.proposal.proposalId === e.proposalId,
      )?.event;
      const verb = e.decision === "denied" ? "denied" : "approved";
      if (asked?.type === "proposal") {
        const p = asked.proposal;
        return `You ${verb} ${money(p.amount)} from the ${agentName(roleOf(p.warrantId))}.`;
      }
      return `You ${verb} new limits.`;
    }
  }
  return null;
}

/**
 * Runs of alike items folded into one, oldest first: twenty identical blocked payments become one
 * row with n = 20. Only neighbours fold, so the order of what happened stays true.
 */
export function foldRepeats<T>(items: T[], keyOf: (t: T) => string): { item: T; n: number }[] {
  const out: { item: T; n: number; key: string }[] = [];
  for (const item of items) {
    const key = keyOf(item);
    const prev = out[out.length - 1];
    if (prev && prev.key === key) {
      prev.n += 1;
      prev.item = item;
    } else out.push({ item, n: 1, key });
  }
  return out.map(({ item, n }) => ({ item, n }));
}
