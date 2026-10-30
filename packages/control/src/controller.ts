import type { KeyObject } from "node:crypto";
import { PaymentProposal, PurposeVerdict } from "@warrant/contracts";
import type {
  ControlDecision,
  Money,
  PaymentSummary,
  Rail,
  RulesResult,
  SignedOrderRecord,
  Warrant,
} from "@warrant/contracts";
import type { RailAdapter, RailStatus } from "@warrant/rails";
import { ApprovalBook } from "./approvals/index.js";
import type { ApprovalView, PendingApproval } from "./approvals/index.js";
import { REFUND_WITHOUT_OWNER_MAX, REFUNDS_WITHOUT_OWNER_PER_DAY } from "./business.js";
import { verifyWarrant } from "./crypto.js";
import { Ledger } from "./ledger/index.js";
import type { Reservation } from "./ledger/index.js";
import { KillSwitch } from "./killswitch/index.js";
import type { KillSwitchHooks, KillSwitchResult } from "./killswitch/index.js";
import { checkRules } from "./rules/index.js";
import type { RulesContext } from "./rules/index.js";

/**
 * The submit path: the ONLY way money leaves (ARCHITECTURE.md).
 *
 *   PaymentProposal -> rules -> purpose -> owner approval (ADR-007) -> ledger reserve
 *     -> rail -> confirm | release | unconfirmed
 *
 * Agents call submit() and get a decision back; they never see a rail, a key or a credential.
 */

/** Lane A plugs the purpose model in here. It sees ONLY the signed warrant and the summary. */
export interface PurposeChecker {
  readonly model: string;
  check(warrant: Warrant, summary: PaymentSummary, now: Date): Promise<PurposeVerdict>;
}

/**
 * Until the purpose model lands, every payment that passes the rules goes to the owner. Failing
 * safe: "uncertain" always escalates (ADR-007 item 5), it never executes on its own.
 */
export const ownerReviewsEverything: PurposeChecker = {
  model: "none (owner reviews)",
  check: (_w, s, now) =>
    Promise.resolve({
      proposalId: s.proposalId,
      verdict: "uncertain",
      reasons: ["insufficient_information"],
      explanation: "no purpose model wired yet: the owner reviews every payment",
      model: "none (owner reviews)",
      evaluatedAt: now.toISOString(),
    }),
};

/** ADR-007 item 4: Airwallex transfers and FX at or above USD 100.00 always need the owner. */
export const OWNER_REVIEW_THRESHOLD_CENTS = 10_000;

export interface Execution {
  reservationId: string;
  status: RailStatus;
  railRef?: string;
  detail?: string;
}

export interface SubmitResult {
  /** Absent only when the proposal was malformed or named no known warrant. */
  decision?: ControlDecision;
  summary?: PaymentSummary;
  approval?: PendingApproval;
  execution?: Execution;
  /** Which layer stopped it, if any. */
  blockedBy?: "malformed" | "rules" | "purpose" | "owner" | "rail";
  error?: string;
}

export type ControlEvent =
  | { type: "proposal"; proposal: PaymentProposal; result: SubmitResult }
  | { type: "approval_requested"; pending: PendingApproval }
  | { type: "approval_decided"; proposalId: string; ok: boolean; decision?: "approved" | "denied" }
  | { type: "execution"; proposalId: string; execution: Execution }
  | { type: "kill_switch"; result: KillSwitchResult };

export interface ControllerOptions {
  ownerPublicKey: KeyObject;
  /** The owner's signed warrants, by id. */
  getWarrant: (warrantId: string) => Warrant | undefined;
  rails: Partial<Record<Rail, RailAdapter>>;
  purpose?: PurposeChecker;
  ledger?: Ledger;
  /** Stored signed orders by orderId (refunds go to an order's payer, capped at its price). */
  orders?: () => ReadonlyMap<string, SignedOrderRecord>;
  /** metal_x402: the mandate credential file name inside METAL_HOME for this warrant. */
  credentialFor?: (warrant: Warrant) => string | undefined;
  /** An outside kill switch, OR'd with the controller's own (`engageKillSwitch`). */
  killSwitchEngaged?: () => boolean;
  clock?: () => Date;
  onEvent?: (e: ControlEvent) => void;
}

const DAY_MS = 24 * 60 * 60 * 1000;

const isRefund = (p: PaymentProposal) =>
  p.category === "customer_refund" || p.refundOfOrderId !== undefined;

export class Controller {
  readonly ledger: Ledger;
  readonly approvals = new ApprovalBook();
  readonly killSwitch = new KillSwitch();
  private readonly purpose: PurposeChecker;
  private readonly clock: () => Date;
  private readonly proposals = new Map<string, PaymentProposal>();

  constructor(private readonly opts: ControllerOptions) {
    this.ledger = opts.ledger ?? new Ledger();
    this.purpose = opts.purpose ?? ownerReviewsEverything;
    this.clock = opts.clock ?? (() => new Date());
  }

  /** The one entry point for agents. Never throws on bad input: returns a blocked result. */
  async submit(raw: unknown): Promise<SubmitResult> {
    const parsed = PaymentProposal.safeParse(raw);
    if (!parsed.success) return { blockedBy: "malformed", error: "malformed proposal" };
    const proposal = parsed.data;
    const result = await this.decide(proposal);
    this.emit({ type: "proposal", proposal, result });
    return result;
  }

  /** The owner's answer to a pending approval. */
  async decideApproval(raw: unknown): Promise<SubmitResult & { ok: boolean }> {
    const proposalId =
      raw && typeof raw === "object" && "proposalId" in raw ? String(raw.proposalId) : "";
    const proposal = this.proposals.get(proposalId);
    const warrant = proposal ? this.opts.getWarrant(proposal.warrantId) : undefined;
    const current = proposal && warrant ? this.approvalView(proposal, warrant) : undefined;
    const outcome = this.approvals.decide(raw, current);
    if (!outcome.ok) {
      this.emit({ type: "approval_decided", proposalId, ok: false });
      return { ok: false, error: outcome.error };
    }
    this.emit({ type: "approval_decided", proposalId, ok: true, decision: outcome.decision });
    this.proposals.delete(proposalId);
    if (outcome.decision === "denied") return { ok: true, blockedBy: "owner" };
    if (!proposal || !warrant) return { ok: false, error: "proposal no longer known" };

    // Time has passed since the owner looked: the rules run again before any money moves.
    const now = this.clock();
    const rules = checkRules(warrant, proposal, this.rulesContext(warrant, now));
    if (!rules.pass) {
      return {
        ok: false,
        decision: decision(proposal, "blocked", rules, null, now),
        blockedBy: "rules",
      };
    }
    return { ok: true, ...(await this.execute(proposal, warrant, rules, null, now)) };
  }

  /**
   * Resolve reservations left unconfirmed by a timeout or an ambiguous rail answer, by asking the
   * rail for the outcome. Money stays held until the rail says what happened.
   */
  async reconcile(): Promise<{ confirmed: string[]; released: string[]; still: string[] }> {
    const out = { confirmed: [] as string[], released: [] as string[], still: [] as string[] };
    for (const r of this.ledger.unconfirmed()) {
      const rail = this.opts.rails[r.rail];
      const s = rail ? await rail.getStatus(r.idempotencyKey).catch(() => undefined) : undefined;
      if (s?.status === "succeeded") {
        this.ledger.confirm(r.reservationId, s.railRef);
        out.confirmed.push(r.reservationId);
      } else if (s?.status === "failed") {
        this.ledger.release(r.reservationId, s.railRef);
        out.released.push(r.reservationId);
      } else {
        out.still.push(r.reservationId);
      }
    }
    return out;
  }

  /**
   * The owner's emergency stop. Refuses every new payment from the first line, drops everything
   * waiting for approval, then freezes cards and revokes mandates through the hooks.
   */
  async engageKillSwitch(
    input: { ownerId: string; reason: string; warrantIds: string[] },
    hooks: KillSwitchHooks = {},
  ): Promise<KillSwitchResult> {
    const now = this.clock();
    this.killSwitch.flip(now);
    for (const id of this.approvals.clear()) this.proposals.delete(id);
    const result = await this.killSwitch.finish(
      {
        eventId: `kill_${now.getTime()}`,
        ownerId: input.ownerId,
        reason: input.reason.slice(0, 500),
        revokedWarrantIds: input.warrantIds,
        // Nothing is reserved without being handed to a rail at once; those settle or fail.
        releasedReservationIds: [],
        at: now.toISOString(),
      },
      hooks,
      this.clock,
    );
    this.emit({ type: "kill_switch", result });
    return result;
  }

  private stopped(): boolean {
    return this.killSwitch.engaged || (this.opts.killSwitchEngaged?.() ?? false);
  }

  get purposeModel(): string {
    return this.purpose.model;
  }

  proposal(proposalId: string): PaymentProposal | undefined {
    return this.proposals.get(proposalId);
  }

  // ---- the path ----

  private async decide(proposal: PaymentProposal): Promise<SubmitResult> {
    const now = this.clock();
    const warrant = this.opts.getWarrant(proposal.warrantId);
    if (!warrant) return { blockedBy: "rules", error: "no such warrant" };

    // 1. Rules, in code. Every rule runs so the owner sees every reason.
    const rules = checkRules(warrant, proposal, this.rulesContext(warrant, now));
    if (!rules.pass) {
      return { decision: decision(proposal, "blocked", rules, null, now), blockedBy: "rules" };
    }

    // 2. Purpose, by a separate model that sees only the warrant and the summary.
    const summary = this.buildSummary(proposal, warrant, now);
    const verdict = await this.checkPurpose(warrant, summary, now);
    if (verdict.verdict === "inconsistent") {
      return {
        decision: decision(proposal, "blocked", rules, verdict, now),
        summary,
        blockedBy: "purpose",
      };
    }

    // 3. The owner, when ADR-007 says so.
    const reasons = this.approvalReasons(proposal, warrant, verdict);
    if (reasons.length > 0) {
      this.proposals.set(proposal.proposalId, proposal);
      const pending = this.approvals.request(
        proposal.proposalId,
        this.approvalView(proposal, warrant),
        reasons,
        now,
      );
      this.emit({ type: "approval_requested", pending });
      return {
        decision: decision(proposal, "needs_owner_approval", rules, verdict, now),
        summary,
        approval: pending,
      };
    }

    // 4. Reserve, pay, settle.
    return { ...(await this.execute(proposal, warrant, rules, verdict, now)), summary };
  }

  /** A model failure or a malformed answer escalates to the owner; it never executes. */
  private async checkPurpose(
    warrant: Warrant,
    summary: PaymentSummary,
    now: Date,
  ): Promise<PurposeVerdict> {
    try {
      const v = PurposeVerdict.safeParse(await this.purpose.check(warrant, summary, now));
      if (v.success && v.data.proposalId === summary.proposalId) return v.data;
    } catch {
      // fall through
    }
    return {
      proposalId: summary.proposalId,
      verdict: "uncertain",
      reasons: ["insufficient_information"],
      explanation: "purpose check failed or answered out of format; the owner decides",
      model: this.purpose.model,
      evaluatedAt: now.toISOString(),
    };
  }

  /** ADR-007: why the owner must look, or [] to execute now. */
  private approvalReasons(p: PaymentProposal, w: Warrant, v: PurposeVerdict): string[] {
    const reasons: string[] = [];
    if (v.verdict === "uncertain") reasons.push(`purpose check uncertain: ${v.reasons.join(", ")}`);
    // ADR-013: signing the warrant approved its payees, so a first payment no longer asks.
    // Refunds the rules accepted (real order, its payer, at most its price, once) ask only when
    // they look unusual.
    if (isRefund(p)) reasons.push(...this.unusualRefund(p, w));
    if (p.recurrence === "recurring") reasons.push("recurring payment");
    if (
      (p.rail === "airwallex_transfer" || p.rail === "airwallex_fx") &&
      p.amount.cents >= OWNER_REVIEW_THRESHOLD_CENTS
    ) {
      reasons.push("Airwallex transfer or FX of 100.00 or more");
    }
    return reasons;
  }

  private async execute(
    proposal: PaymentProposal,
    warrant: Warrant,
    rules: RulesResult,
    verdict: PurposeVerdict | null,
    now: Date,
  ): Promise<SubmitResult> {
    const routingRef = this.routingRef(proposal, warrant);
    const rail = this.opts.rails[proposal.rail];
    if (!routingRef || !rail) {
      return {
        decision: decision(proposal, "blocked", rules, verdict, now),
        blockedBy: "rail",
        error: !rail ? `no adapter for ${proposal.rail}` : "no routing for this payee",
      };
    }

    // The kill switch may have been pressed while the purpose model or the owner was thinking.
    if (this.stopped()) {
      return {
        decision: decision(proposal, "blocked", rules, verdict, now),
        blockedBy: "rules",
        error: "kill switch engaged",
      };
    }

    let reservation: Reservation;
    try {
      reservation = this.ledger.reserve({
        proposalId: proposal.proposalId,
        warrantId: warrant.warrantId,
        rail: proposal.rail,
        amount: proposal.amount,
        idempotencyKey: proposal.idempotencyKey,
        // refunds are keyed by the order, so one order can't be refunded twice
        payeeId: proposal.refundOfOrderId ?? proposal.payeeId,
      });
    } catch (e) {
      return {
        decision: decision(proposal, "blocked", rules, verdict, now),
        blockedBy: "rules",
        error: (e as Error).message,
      };
    }

    const credentialRef =
      proposal.rail === "metal_x402" ? this.opts.credentialFor?.(warrant) : undefined;
    let status: RailStatus;
    let railRef: string | undefined;
    let detail: string | undefined;
    try {
      const r = await rail.execute({
        rail: proposal.rail,
        reservationId: reservation.reservationId,
        idempotencyKey: proposal.idempotencyKey,
        amount: proposal.amount,
        routingRef,
        ...(proposal.targetCurrency ? { targetCurrency: proposal.targetCurrency } : {}),
        ...(credentialRef ? { credentialRef } : {}),
      });
      ({ status, railRef, detail } = r);
    } catch {
      // An exception after the call started may hide a payment: never treat it as failed.
      status = "unknown";
      detail = "rail call threw; outcome unknown until a status check";
    }

    if (status === "succeeded") this.ledger.confirm(reservation.reservationId, railRef);
    else if (status === "failed") this.ledger.release(reservation.reservationId, railRef);
    else this.ledger.markUnconfirmed(reservation.reservationId, railRef);

    const execution: Execution = {
      reservationId: reservation.reservationId,
      status,
      ...(railRef ? { railRef } : {}),
      ...(detail ? { detail } : {}),
    };
    this.emit({ type: "execution", proposalId: proposal.proposalId, execution });
    return {
      decision: decision(proposal, "execute", rules, verdict, now),
      execution,
      ...(status === "failed" ? { blockedBy: "rail" as const } : {}),
    };
  }

  // ---- what each layer sees ----

  private rulesContext(w: Warrant, now: Date): RulesContext {
    const orders = this.opts.orders?.();
    return {
      now,
      signatureValid: verifyWarrant(w, this.opts.ownerPublicKey),
      killSwitchEngaged: this.stopped(),
      committedCents: this.ledger.committedCents(w.warrantId),
      seenIdempotencyKeys: this.ledger.idempotencyKeys(),
      recentPayments: this.ledger.activeReservations(w.warrantId).map((r) => ({
        payeeId: r.payeeId ?? "",
        rail: r.rail,
        cents: r.amount.cents,
        at: new Date(r.reservedAt),
      })),
      ...(orders ? { orders, refundedOrderIds: this.refundedOrders(w, orders) } : {}),
    };
  }

  private refundedOrders(
    w: Warrant,
    orders: ReadonlyMap<string, SignedOrderRecord>,
  ): ReadonlySet<string> {
    const ids = new Set<string>();
    for (const r of this.ledger.activeReservations(w.warrantId)) {
      if (r.payeeId && orders.has(r.payeeId)) ids.add(r.payeeId);
    }
    return ids;
  }

  /**
   * The purpose checker's whole view of a payment: structured fields only. Never the agent's
   * justification, never offer or invoice text (the schema is strict, so none can be added).
   */
  buildSummary(p: PaymentProposal, w: Warrant, now: Date): PaymentSummary {
    const payee = w.payees.find((x) => x.payeeId === p.payeeId && x.rail === p.rail);
    const toPayee = this.ledger
      .activeReservations(w.warrantId)
      .filter((r) => r.payeeId === p.payeeId && r.rail === p.rail);
    const lastConfirmed = toPayee.filter((r) => r.state === "confirmed").at(-1);
    const last = lastConfirmed?.amount.cents;
    const committed = this.ledger.committedCents(w.warrantId);
    const money = (cents: number): Money => ({ currency: w.totalBudget.currency, cents });
    return {
      proposalId: p.proposalId,
      warrantId: w.warrantId,
      agentRole: p.agentRole,
      rail: p.rail,
      payee: {
        payeeId: p.payeeId,
        displayName: payee?.displayName ?? (isRefund(p) ? "customer refund" : "not on warrant"),
        onAllowlist: payee !== undefined,
      },
      amount: p.amount,
      category: p.category,
      recurrence: p.recurrence,
      priceChangeBps:
        last === undefined || last === 0
          ? null
          : Math.round(((p.amount.cents - last) * 10_000) / last),
      spentSoFar: money(this.ledger.spentCents(w.warrantId)),
      budgetRemainingAfter: money(Math.max(0, w.totalBudget.cents - committed - p.amount.cents)),
      paymentsToPayeeLast24h: toPayee.filter(
        (r) => now.getTime() - Date.parse(r.reservedAt) <= DAY_MS,
      ).length,
    };
  }

  /**
   * What the owner approves. Only fields fixed by the proposal and the signed warrant, so busy
   * agents don't void it; a new warrant version or a changed payee does.
   */
  private approvalView(p: PaymentProposal, w: Warrant): ApprovalView {
    const payee = w.payees.find((x) => x.payeeId === p.payeeId && x.rail === p.rail);
    return {
      proposalId: p.proposalId,
      agent: { agentId: p.agentId, role: p.agentRole },
      warrant: { warrantId: w.warrantId, version: w.version },
      payee: isRefund(p)
        ? { refundOfOrderId: p.refundOfOrderId ?? null }
        : { payeeId: p.payeeId, displayName: payee?.displayName ?? null },
      routingRef: this.routingRef(p, w) ?? null,
      amount: p.amount,
      rail: p.rail,
      category: p.category,
      recurrence: p.recurrence,
    };
  }

  /** Where the money goes: from the warrant, or for a refund, the order's payer. Never agent input. */
  private routingRef(p: PaymentProposal, w: Warrant): string | undefined {
    if (isRefund(p)) {
      return p.refundOfOrderId ? this.opts.orders?.().get(p.refundOfOrderId)?.payer : undefined;
    }
    return w.payees.find((x) => x.payeeId === p.payeeId && x.rail === p.rail)?.routingRef;
  }

  /** ADR-013: why a refund needs the owner, or [] when it may go through on its own. */
  private unusualRefund(p: PaymentProposal, w: Warrant): string[] {
    const why: string[] = [];
    if (p.amount.cents > REFUND_WITHOUT_OWNER_MAX.cents) {
      why.push(`refund over ${REFUND_WITHOUT_OWNER_MAX.cents} cents`);
    }
    const orders = this.opts.orders?.();
    const payer = p.refundOfOrderId ? orders?.get(p.refundOfOrderId)?.payer : undefined;
    if (orders && payer) {
      const since = this.clock().getTime() - DAY_MS;
      const recent = this.ledger
        .activeReservations(w.warrantId)
        .filter(
          (r) =>
            r.payeeId !== undefined &&
            orders.get(r.payeeId)?.payer.toLowerCase() === payer.toLowerCase() &&
            Date.parse(r.reservedAt) >= since,
        ).length;
      if (recent >= REFUNDS_WITHOUT_OWNER_PER_DAY) {
        why.push(`refund number ${recent + 1} to this customer in 24 hours`);
      }
    }
    return why;
  }

  private emit(e: ControlEvent): void {
    this.opts.onEvent?.(e);
  }
}

function decision(
  p: PaymentProposal,
  outcome: ControlDecision["outcome"],
  rules: RulesResult,
  purpose: PurposeVerdict | null,
  now: Date,
): ControlDecision {
  return { proposalId: p.proposalId, outcome, rules, purpose, decidedAt: now.toISOString() };
}
