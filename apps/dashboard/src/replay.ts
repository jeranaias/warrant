import type { Money } from "./api.js";
import { agentName, money, short } from "./format.js";
import type { Names, Tone } from "./format.js";
import { REASONS } from "./flow.js";

/**
 * The replay log (GET /replay?proposalId=, control's `replay()`): one request's life, step by
 * step, in plain words. Pure, so replay.test.ts can pin the wording. Ids go in `ids`, never in
 * the headline.
 */

export type ReplayStep =
  | {
      kind: "asked";
      at: string;
      agentId: string;
      agentRole: string;
      warrantId: string;
      payeeId: string;
      rail: string;
      amount: Money;
      refundOfOrderId?: string;
    }
  | {
      kind: "asked_limits";
      at: string;
      proposedBy: string;
      warrantId: string;
      agentRole: string;
      from: { perPaymentCap: Money; totalBudget: Money };
      to: { perPaymentCap: Money; totalBudget: Money };
    }
  | { kind: "malformed"; at: string; error: string }
  | {
      kind: "rules";
      at: string;
      pass: boolean;
      checks: { rule: string; pass: boolean; detail: string }[];
    }
  | {
      kind: "purpose";
      at: string;
      verdict: "consistent" | "inconsistent" | "uncertain";
      reasons: string[];
      explanation: string;
      model: string;
    }
  | { kind: "purpose_skipped"; at: string }
  | { kind: "owner_asked"; at: string; reasons: string[]; shownHash: string }
  | { kind: "owner_decided"; at: string; decision: "approved" | "denied" }
  | { kind: "owner_refused"; at: string }
  | { kind: "limits_signed"; at: string; fromVersion: number; toVersion: number }
  | {
      kind: "ledger";
      at: string;
      entry: "reserve" | "confirm" | "release" | "unconfirmed" | "inbound" | "kill_switch";
      reservationId: string;
      amount: Money;
      railRef?: string;
      rail?: { status: string; detail?: string; statusCheck: boolean };
    }
  | { kind: "rail_error"; at: string; error: string };

export interface Replay {
  proposalId: string;
  found: boolean;
  outcome:
    | "paid"
    | "blocked"
    | "waiting"
    | "denied"
    | "unconfirmed"
    | "rail_failed"
    | "released"
    | "limits_signed"
    | "unknown";
  stoppedBy?: "malformed" | "rules" | "purpose" | "owner" | "rail";
  steps: ReplayStep[];
}

export interface ReplayCheck {
  ok: boolean;
  label: string;
  detail?: string;
}

export interface ReplayLine {
  at: string;
  tone: Tone;
  text: string;
  why?: string;
  /** Rule by rule, for the rules step. */
  checks?: ReplayCheck[];
  /** Ids and hashes, shown small under the line. */
  ids?: string;
}

/** Labels for every rule, not only the ones that block (REASONS words a failure). */
const RULE_LABELS: Record<string, string> = {
  warrant_active: "warrant active",
  warrant_expiry: "inside the warrant's dates",
  rail_allowed: "rail on the warrant",
  payee_allowlist: "payee on the warrant",
  currency_match: "currency matches",
  per_payment_cap: "under the per-payment cap",
  total_budget: "inside the total budget",
  duplicate_guard: "not a repeat",
  refund_matches_order: "refund matches an order",
};

const PURPOSE_WORDS: Record<string, string> = {
  consistent: "fits the warrant's purpose",
  inconsistent: "doesn't fit the warrant's purpose",
  uncertain: "unsure",
};

const words = (code: string) => code.replaceAll("_", " ");

export const OUTCOME_WORDS: Record<Replay["outcome"], { tone: Tone; text: string }> = {
  paid: { tone: "ok", text: "Paid" },
  blocked: { tone: "stop", text: "Blocked" },
  waiting: { tone: "wait", text: "Waiting for you" },
  denied: { tone: "stop", text: "Denied by you" },
  unconfirmed: { tone: "wait", text: "In doubt: held until a status check" },
  rail_failed: { tone: "stop", text: "Refused by the rail" },
  released: { tone: "info", text: "Released" },
  limits_signed: { tone: "owner", text: "New limits signed" },
  unknown: { tone: "info", text: "Recorded" },
};

/** The headline for a replay: the outcome, and which layer stopped it. */
export function outcomeLine(r: Replay): { tone: Tone; text: string } {
  const o = OUTCOME_WORDS[r.outcome];
  if (r.outcome !== "blocked" || !r.stoppedBy) return o;
  const by = { rules: "the rules", purpose: "the purpose check", malformed: "a malformed request" };
  const who = by[r.stoppedBy as keyof typeof by];
  return who ? { tone: o.tone, text: `Blocked by ${who}` } : o;
}

/** "payee not on warrant" and "payee not on the warrant" say the same thing. */
function sameWords(a: string, b: string): boolean {
  const norm = (t: string) =>
    t
      .toLowerCase()
      .replace(/\b(the|a|an)\b/g, "")
      .replace(/[^a-z0-9]+/g, " ")
      .trim();
  return norm(a) === norm(b);
}

/** Every step of a replay as one plain line. */
export function replayLines(r: Replay, names: Names): ReplayLine[] {
  return r.steps.map((s): ReplayLine => {
    switch (s.kind) {
      case "asked": {
        const who = agentName(s.agentRole);
        const to = names.payee(s.payeeId);
        const text = s.refundOfOrderId
          ? `${who} asked to refund ${money(s.amount)}${to ? ` to ${to}` : ""}`
          : `${who} asked to pay ${money(s.amount)}${to ? ` to ${to}` : ""}`;
        const ids = [r.proposalId, s.warrantId, words(s.rail), ...(to ? [] : [s.payeeId])];
        if (s.refundOfOrderId) ids.push(`order ${s.refundOfOrderId}`);
        return { at: s.at, tone: "info", text, ids: ids.join(" · ") };
      }
      case "asked_limits":
        return {
          at: s.at,
          tone: "info",
          text: `New limits asked for the ${agentName(s.agentRole)}: per payment ${money(s.from.perPaymentCap)} → ${money(s.to.perPaymentCap)}, in total ${money(s.from.totalBudget)} → ${money(s.to.totalBudget)}`,
          ids: [r.proposalId, s.warrantId, `asked by ${s.proposedBy}`].join(" · "),
        };
      case "malformed":
        return { at: s.at, tone: "stop", text: "Refused: not a valid request", why: s.error };
      case "rules": {
        const failed = s.checks.filter((c) => !c.pass);
        return {
          at: s.at,
          tone: s.pass ? "ok" : "stop",
          text: s.pass
            ? `Rules: all ${s.checks.length} checks passed`
            : `Rules: ${failed.length} of ${s.checks.length} failed`,
          checks: s.checks.map((c) => {
            const label = c.pass
              ? (RULE_LABELS[c.rule] ?? words(c.rule))
              : (REASONS[c.rule] ?? words(c.rule));
            // The detail only when it adds something ("9900 vs cap 5000"), not the label again.
            const extra = !c.pass && !sameWords(c.detail, label);
            return { ok: c.pass, label, ...(extra ? { detail: c.detail } : {}) };
          }),
          // Each failed check carries its own detail beside it, so no line-level why.
        };
      }
      case "purpose":
        return {
          at: s.at,
          tone: s.verdict === "consistent" ? "ok" : s.verdict === "inconsistent" ? "stop" : "wait",
          text: `Purpose check: ${PURPOSE_WORDS[s.verdict] ?? s.verdict}`,
          ...(s.verdict === "consistent" ? {} : { why: s.explanation }),
          ids: [s.reasons.map(words).join(", "), s.model].join(" · "),
        };
      case "purpose_skipped":
        return { at: s.at, tone: "info", text: "Purpose check not run: the rules already said no" };
      case "owner_asked":
        return {
          at: s.at,
          tone: "wait",
          text: "Held for you",
          why: s.reasons.join("; "),
          ids: `shown ${short(s.shownHash)}`,
        };
      case "owner_decided":
        return {
          at: s.at,
          tone: s.decision === "approved" ? "owner" : "stop",
          text: s.decision === "approved" ? "You approved" : "You denied",
        };
      case "owner_refused":
        return {
          at: s.at,
          tone: "stop",
          text: "An answer was refused: what you saw had changed",
        };
      case "limits_signed":
        return {
          at: s.at,
          tone: "owner",
          text: `New limits signed: warrant v${s.fromVersion} → v${s.toVersion}`,
        };
      case "rail_error":
        return { at: s.at, tone: "stop", text: "Not sent", why: s.error };
      case "ledger":
        return ledgerLine(s);
    }
  });
}

function ledgerLine(s: Extract<ReplayStep, { kind: "ledger" }>): ReplayLine {
  const ids = [s.reservationId, ...(s.railRef ? [s.railRef] : [])].join(" · ");
  const check = s.rail?.statusCheck ? ", found by a status check" : "";
  switch (s.entry) {
    case "reserve":
      return { at: s.at, tone: "info", text: `Funds held: ${money(s.amount)}`, ids };
    case "unconfirmed":
      return {
        at: s.at,
        tone: "wait",
        text: "Rail answer unknown: the funds stay held until a status check",
        ...(s.rail?.detail ? { why: s.rail.detail } : {}),
        ids,
      };
    case "confirm":
      return { at: s.at, tone: "ok", text: `Money moved: ${money(s.amount)}${check}`, ids };
    case "release":
      return s.rail
        ? {
            at: s.at,
            tone: "stop",
            text: `The rail refused it: funds released${check}`,
            ...(s.rail.detail ? { why: s.rail.detail } : {}),
            ids,
          }
        : { at: s.at, tone: "info", text: "Funds released", ids };
    default:
      return { at: s.at, tone: "info", text: words(s.entry), ids };
  }
}
