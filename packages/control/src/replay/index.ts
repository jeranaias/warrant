import type {
  LedgerEntry,
  LedgerEntryType,
  Money,
  PurposeVerdict,
  Rail,
  RuleCheck,
} from "@warrant/contracts";
import type { ControlEvent, Execution } from "../controller.js";

/**
 * The replay log (#22): one proposal's life, step by step, from the event log and the ledger.
 * Read-only. It never changes a decision; it only puts what control already recorded in order:
 *
 *   asked -> rules (every check) -> purpose -> owner -> ledger (reserve, unconfirmed,
 *     confirm | release) with each rail answer -> outcome
 */

export type ReplayStep =
  | {
      kind: "asked";
      at: string;
      agentId: string;
      agentRole: string;
      warrantId: string;
      payeeId: string;
      rail: Rail;
      amount: Money;
      refundOfOrderId?: string;
    }
  | {
      kind: "asked_limits";
      at: string;
      /** Who asked (the agent id), and whose warrant it changes. */
      proposedBy: string;
      warrantId: string;
      agentRole: string;
      from: { perPaymentCap: Money; totalBudget: Money };
      to: { perPaymentCap: Money; totalBudget: Money };
    }
  | { kind: "malformed"; at: string; error: string }
  | { kind: "rules"; at: string; pass: boolean; checks: RuleCheck[] }
  | {
      kind: "purpose";
      at: string;
      verdict: PurposeVerdict["verdict"];
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
      entry: LedgerEntryType;
      reservationId: string;
      amount: Money;
      railRef?: string;
      /** The rail's answer that led to this entry, when there was one. */
      rail?: { status: Execution["status"]; detail?: string; statusCheck: boolean };
    }
  | { kind: "rail_error"; at: string; error: string };

export type ReplayOutcome =
  | "paid"
  | "blocked"
  | "waiting"
  | "denied"
  | "unconfirmed"
  | "rail_failed"
  | "released"
  | "limits_signed"
  | "unknown";

export interface Replay {
  proposalId: string;
  found: boolean;
  outcome: ReplayOutcome;
  /** Which layer stopped it, when it was stopped. */
  stoppedBy?: "malformed" | "rules" | "purpose" | "owner" | "rail";
  steps: ReplayStep[];
}

export interface ReplayEvent {
  at: string;
  event: ControlEvent;
}

const RESOLVES: ReadonlySet<LedgerEntryType> = new Set(["confirm", "release", "unconfirmed"]);

function proposalIdOf(e: ControlEvent): string | undefined {
  switch (e.type) {
    case "proposal":
      return e.proposal.proposalId;
    case "approval_requested":
      return e.pending.proposalId;
    case "approval_decided":
    case "execution":
    case "budget_changed":
      return e.proposalId;
    default:
      return undefined;
  }
}

/** One proposal's replay. `found` is false when nothing in the log names it. */
export function replay(
  proposalId: string,
  events: readonly ReplayEvent[],
  ledger: readonly LedgerEntry[],
): Replay {
  const mine = events.filter((e) => proposalIdOf(e.event) === proposalId);
  const entries = ledger.filter((l) => l.proposalId === proposalId);
  const steps: ReplayStep[] = [];
  let stoppedBy: Replay["stoppedBy"];

  const submitted = mine.find((e) => e.event.type === "proposal");
  const requested = mine.find((e) => e.event.type === "approval_requested");
  const decided = mine.filter((e) => e.event.type === "approval_decided");
  const executions = mine.flatMap((e) =>
    e.event.type === "execution" ? [{ at: e.at, ex: e.event.execution }] : [],
  );
  const signed = mine.find((e) => e.event.type === "budget_changed");

  if (submitted && submitted.event.type === "proposal") {
    const { proposal: p, result } = submitted.event;
    const decision = result.decision;
    const at = decision?.rules.evaluatedAt ?? submitted.at;
    steps.push({
      kind: "asked",
      at: p.createdAt,
      agentId: p.agentId,
      agentRole: p.agentRole,
      warrantId: p.warrantId,
      payeeId: p.payeeId,
      rail: p.rail,
      amount: p.amount,
      ...(p.refundOfOrderId ? { refundOfOrderId: p.refundOfOrderId } : {}),
    });
    if (!decision) {
      steps.push({ kind: "malformed", at, error: result.error ?? "no decision" });
      stoppedBy = result.blockedBy ?? "malformed";
    } else {
      steps.push({ kind: "rules", at, pass: decision.rules.pass, checks: decision.rules.checks });
      if (decision.purpose) {
        const v = decision.purpose;
        steps.push({
          kind: "purpose",
          at: v.evaluatedAt,
          verdict: v.verdict,
          reasons: [...v.reasons],
          explanation: v.explanation,
          model: v.model,
        });
      } else {
        steps.push({ kind: "purpose_skipped", at });
      }
      if (result.blockedBy === "rules" || result.blockedBy === "purpose")
        stoppedBy = result.blockedBy;
      // A rule-level throw after the checks passed (e.g. a reserve refused): keep the reason.
      if (result.blockedBy === "rules" && decision.rules.pass && result.error) {
        steps.push({ kind: "rail_error", at, error: result.error });
      }
    }
  } else if (requested && requested.event.type === "approval_requested") {
    // A budget change: no payment proposal, only the owner's request (control's budgetView).
    const view = requested.event.pending.view;
    if (view["kind"] === "budget_change") {
      const w = view["warrant"] as { warrantId: string; role: string } | undefined;
      const from = view["from"] as { perPaymentCap: Money; totalBudget: Money } | undefined;
      const to = view["to"] as { perPaymentCap: Money; totalBudget: Money } | undefined;
      if (w && from && to) {
        steps.push({
          kind: "asked_limits",
          at: requested.at,
          proposedBy: String(view["proposedBy"] ?? ""),
          warrantId: w.warrantId,
          agentRole: w.role,
          from,
          to,
        });
      }
    }
  }

  if (requested && requested.event.type === "approval_requested") {
    const p = requested.event.pending;
    steps.push({
      kind: "owner_asked",
      at: p.requestedAt,
      reasons: [...p.reasons],
      shownHash: p.shownHash,
    });
  }
  let denied = false;
  for (const d of decided) {
    if (d.event.type !== "approval_decided") continue;
    if (!d.event.ok || !d.event.decision) {
      steps.push({ kind: "owner_refused", at: d.at });
      continue;
    }
    steps.push({ kind: "owner_decided", at: d.at, decision: d.event.decision });
    if (d.event.decision === "denied") denied = true;
  }
  if (denied) stoppedBy = "owner";
  if (signed && signed.event.type === "budget_changed") {
    steps.push({
      kind: "limits_signed",
      at: signed.at,
      fromVersion: signed.event.fromVersion,
      toVersion: signed.event.toVersion,
    });
  }

  // Ledger entries in order; each resolving entry is paired with the rail answer behind it
  // (k-th resolving entry of a reservation <-> k-th execution for it).
  const pending = new Map<string, { at: string; ex: Execution }[]>();
  for (const x of executions) {
    const list = pending.get(x.ex.reservationId) ?? [];
    list.push(x);
    pending.set(x.ex.reservationId, list);
  }
  let last: LedgerEntryType | undefined;
  let lastHadRail = false;
  for (const l of entries) {
    if (!l.reservationId) continue;
    const ex = RESOLVES.has(l.type) ? pending.get(l.reservationId)?.shift() : undefined;
    steps.push({
      kind: "ledger",
      at: l.at,
      entry: l.type,
      reservationId: l.reservationId,
      amount: l.amount,
      ...(l.railRef ? { railRef: l.railRef } : {}),
      ...(ex
        ? {
            rail: {
              status: ex.ex.status,
              ...(ex.ex.detail ? { detail: ex.ex.detail } : {}),
              statusCheck: (ex.ex.detail ?? "").startsWith("status check"),
            },
          }
        : {}),
    });
    last = l.type;
    lastHadRail = ex !== undefined;
  }

  let outcome: ReplayOutcome = "unknown";
  if (stoppedBy === "owner") outcome = "denied";
  else if (stoppedBy) outcome = "blocked";
  else if (last === "confirm") outcome = "paid";
  else if (last === "unconfirmed" || last === "reserve") outcome = "unconfirmed";
  else if (last === "release" && lastHadRail) {
    outcome = "rail_failed";
    stoppedBy = "rail";
  } else if (last === "release") {
    outcome = "released"; // freed without a rail answer (STOP)
  } else if (signed) outcome = "limits_signed";
  else if (requested) outcome = "waiting";

  return {
    proposalId,
    found: mine.length > 0 || entries.length > 0,
    outcome,
    ...(stoppedBy ? { stoppedBy } : {}),
    steps,
  };
}
