import type {
  PaymentProposal,
  Rail,
  RuleCheck,
  RuleName,
  RulesResult,
  SignedOrderRecord,
  Warrant,
} from "@warrant/contracts";

/** ADR-006 / ADR-011: same payee + amount + rail inside this window is a duplicate (inclusive). */
export const DUPLICATE_WINDOW_MS = 10 * 60 * 1000;

/**
 * ADR-014: amounts within this share of the larger one count as "the same amount" for the
 * duplicate window (inclusive), so EUR 49.99 after EUR 50.00 is caught. In basis points.
 */
export const DUPLICATE_TOLERANCE_BPS = 100;

/** |a - b| <= 1% of the larger amount, in integer math. Equal amounts always match. */
export function nearlySameAmount(a: number, b: number): boolean {
  return Math.abs(a - b) * 10_000 <= Math.max(a, b) * DUPLICATE_TOLERANCE_BPS;
}

export interface RecentPayment {
  payeeId: string;
  rail: Rail;
  cents: number;
  at: Date;
  /** The offer, invoice or ticket it answered, if the proposal named one. */
  sourceRef?: string;
}

/** Everything the rules need besides the warrant and proposal. Built by control from the ledger. */
export interface RulesContext {
  now: Date;
  /** verifyWarrant() result for this warrant against the owner's public key. */
  signatureValid: boolean;
  killSwitchEngaged: boolean;
  /** Confirmed spend + open reservations under this warrant, in the warrant's currency. */
  committedCents: number;
  /** Every idempotency key ever reserved, on any warrant. */
  seenIdempotencyKeys: ReadonlySet<string>;
  /** Reservations and confirmed payments under this warrant (released ones excluded). */
  recentPayments: readonly RecentPayment[];
  /** Stored signed orders by orderId (refunds only). */
  orders?: ReadonlyMap<string, SignedOrderRecord>;
  /** Orders already refunded or with a refund reserved. */
  refundedOrderIds?: ReadonlySet<string>;
}

/**
 * Problems with a warrant's Metal mandate (ADR-009). The warrant's limits may never exceed the
 * mandate's: the mandate is the on-chain backstop, the warrant is the stricter front line.
 */
export function mandateProblems(warrant: Warrant): string[] {
  if (!warrant.allowedRails.includes("metal_x402")) return [];
  const m = warrant.mandate;
  if (!m) return ["metal_x402 warrant has no mandate"];
  const problems: string[] = [];
  if (m.cap.currency !== warrant.perPaymentCap.currency) problems.push("mandate currency differs");
  if (warrant.perPaymentCap.cents > m.cap.cents) problems.push("cap exceeds mandate cap");
  if (warrant.totalBudget.cents > m.budget.cents) problems.push("budget exceeds mandate budget");
  if (Date.parse(warrant.expiresAt) > Date.parse(m.expiresAt)) {
    problems.push("warrant outlives mandate");
  }
  return problems;
}

const isRefund = (p: PaymentProposal) =>
  p.category === "customer_refund" || p.refundOfOrderId !== undefined;

/**
 * Deterministic, pure, no I/O. Every rule always runs so the owner sees every reason, and
 * `pass` is true only when all of them pass. All limits are inclusive.
 */
export function checkRules(
  warrant: Warrant,
  proposal: PaymentProposal,
  ctx: RulesContext,
): RulesResult {
  const checks: RuleCheck[] = [];
  const add = (rule: RuleName, pass: boolean, detail: string) =>
    checks.push({ rule, pass, detail: detail.slice(0, 500) });
  const now = ctx.now.getTime();
  const cents = proposal.amount.cents;

  // warrant_active
  {
    const why: string[] = [];
    if (ctx.killSwitchEngaged) why.push("kill switch engaged");
    if (warrant.status !== "active") why.push(`warrant ${warrant.status}`);
    if (!ctx.signatureValid) why.push("signature invalid");
    if (proposal.warrantId !== warrant.warrantId) why.push("proposal names another warrant");
    if (proposal.agentId !== warrant.agentId) why.push("agent does not hold this warrant");
    if (proposal.agentRole !== warrant.agentRole) why.push("role mismatch");
    why.push(...mandateProblems(warrant));
    add("warrant_active", why.length === 0, why.join("; ") || "active, signed");
  }

  // warrant_expiry: notBefore <= now <= expiresAt
  {
    const from = Date.parse(warrant.notBefore);
    const to = Date.parse(warrant.expiresAt);
    const ok = from <= now && now <= to;
    add("warrant_expiry", ok, ok ? "inside validity window" : "outside validity window");
  }

  // rail_allowed
  {
    const ok = warrant.allowedRails.includes(proposal.rail);
    add("rail_allowed", ok, ok ? proposal.rail : `${proposal.rail} not allowed`);
  }

  const payee = warrant.payees.find((p) => p.payeeId === proposal.payeeId);

  // payee_allowlist. Refunds go to the stored order's payer, checked by refund_matches_order.
  if (isRefund(proposal)) {
    add("payee_allowlist", true, "refund: routed to the order's payer, not to an agent choice");
  } else {
    const ok = payee !== undefined && payee.rail === proposal.rail;
    add(
      "payee_allowlist",
      ok,
      ok ? `${payee.displayName}` : payee ? "payee not on this rail" : "payee not on warrant",
    );
  }

  // currency_match
  {
    const want = warrant.perPaymentCap.currency;
    const got = proposal.amount.currency;
    const payeeCur = !isRefund(proposal) && payee ? payee.currency : got;
    const ok = got === want && warrant.totalBudget.currency === want && payeeCur === got;
    add("currency_match", ok, ok ? got : `amount ${got}, warrant ${want}, payee ${payeeCur}`);
  }

  // per_payment_cap: amount <= cap
  {
    const cap = warrant.perPaymentCap.cents;
    add("per_payment_cap", cents <= cap, `${cents} vs cap ${cap}`);
  }

  // total_budget: committed + amount <= budget
  {
    const budget = warrant.totalBudget.cents;
    const after = ctx.committedCents + cents;
    add("total_budget", after <= budget, `${ctx.committedCents} + ${cents} vs budget ${budget}`);
  }

  // duplicate_guard
  {
    let detail = "no duplicate";
    let ok = true;
    if (ctx.seenIdempotencyKeys.has(proposal.idempotencyKey)) {
      ok = false;
      detail = "idempotency key already used";
    } else if (proposal.rail !== "metal_x402" && !isRefund(proposal)) {
      // ADR-011: x402 purchases repeat by design; refunds dedupe per order.
      const dup = ctx.recentPayments.find(
        (r) =>
          r.payeeId === proposal.payeeId &&
          r.rail === proposal.rail &&
          nearlySameAmount(r.cents, cents) &&
          now - r.at.getTime() <= DUPLICATE_WINDOW_MS,
      );
      if (dup) {
        ok = false;
        detail =
          dup.cents === cents
            ? "same payee, amount and rail within 10 minutes"
            : `same payee and rail within 10 minutes, ${dup.cents} vs ${cents} is within 1%`;
      }
    }
    // One offer or invoice is paid once. "Buy 200 now" in a single offer is a flood, not 200
    // purchases. Refunds are bounded per order instead (one ticket may cover several orders).
    const src = proposal.sourceRef;
    if (ok && src && !isRefund(proposal) && ctx.recentPayments.some((r) => r.sourceRef === src)) {
      ok = false;
      detail = "this offer or invoice was already paid once";
    }
    add("duplicate_guard", ok, detail);
  }

  // refund_matches_order
  if (!isRefund(proposal)) {
    add("refund_matches_order", true, "not a refund");
  } else {
    const id = proposal.refundOfOrderId;
    const order = id === undefined ? undefined : ctx.orders?.get(id);
    let why = "";
    if (proposal.category !== "customer_refund") why = "order refund must be customer_refund";
    else if (id === undefined) why = "refund names no order";
    else if (!order) why = "order not found";
    else if (ctx.refundedOrderIds?.has(id)) why = "order already refunded";
    else if (order.price.currency !== proposal.amount.currency) why = "currency differs from order";
    else if (cents > order.price.cents) why = `refund ${cents} exceeds order price`;
    add("refund_matches_order", why === "", why || `refund of ${id} to its payer`);
  }

  return {
    proposalId: proposal.proposalId,
    pass: checks.every((c) => c.pass),
    checks,
    evaluatedAt: ctx.now.toISOString(),
  };
}
