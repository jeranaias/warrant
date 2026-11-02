import type { PaymentProposal } from "@warrant/contracts";
import { UPSTREAM_PRICE_AFTER, UPSTREAM_PRICE_BEFORE } from "@warrant/control";
import type { DisputeFile } from "@warrant/control";
import { classifyPay } from "@warrant/rails";
import { answerDispute } from "./disputes.js";
import { createEngine } from "./server.js";
import type { Engine } from "./server.js";
import { AGENTS, OWNER_ID } from "./world.js";

/**
 * Kit 11 beat: the upstream price rises from 2 cents to 4, over sourcing's 3-cent cap.
 * Played on the mock chain by default; pass a sandbox engine (`live.ts`) to play it on testnet:
 *   1. purchases at 2 cents go through (the payee is on the signed warrant: no owner tap)
 *   2. the price rises; the 4-cent purchase is refused by our rules, before any chain call
 *   3. an agent that claims the old price is refused by the rail: the seller now asks 4
 *   4. sent around Warrant ("limits only"), the chain's mandate refuses it: mandate_cap_exceeded
 */
export interface SceneStep {
  step: string;
  outcome: string;
  moneyMoved: boolean;
  /** The settlement transaction when money moved. */
  tx?: string;
  /** What the step rests on, one line each (e.g. a dispute's on-chain checks). */
  notes?: string[];
}

export const explorerTx = (tx: string) => `https://testnet.metalntwx.com/tx/${tx}`;

/** The step's settlement transaction, if a payment settled since `before`. */
function moved(engine: Engine, before: number): Pick<SceneStep, "moneyMoved" | "tx"> {
  const settled = engine.world.settled();
  const tx = settled.length > before ? settled[settled.length - 1] : undefined;
  return tx ? { moneyMoved: true, tx } : { moneyMoved: false };
}

export async function priceRiseScene(
  now = () => new Date(),
  engine = createEngine({ scenario: "none", clock: now }),
): Promise<SceneStep[]> {
  const { controller, world } = engine;
  const steps: SceneStep[] = [];
  const who = AGENTS.sourcing;
  let n = 0;
  const buy = (cents: number): PaymentProposal => ({
    proposalId: `prop_scene_${++n}`,
    warrantId: who.warrantId,
    agentId: who.agentId,
    agentRole: "sourcing",
    rail: "metal_x402",
    payeeId: "pay_upstream",
    amount: { currency: "USDZ", cents },
    category: "data_purchase",
    recurrence: "one_off",
    idempotencyKey: `scene-price-rise-${n}`,
    justification: "hourly forecast batch",
    createdAt: now().toISOString(),
  });
  const paidCount = () => world.settled().length;

  // 1. Buying at 2 cents.
  for (let k = 0; k < 2; k++) {
    const before = paidCount();
    const r = await controller.submit(buy(UPSTREAM_PRICE_BEFORE.cents));
    let outcome = r.decision?.outcome ?? r.blockedBy ?? "error";
    if (r.approval) {
      const decided = await controller.decideApproval({
        approvalId: `apr_${r.approval.proposalId}`,
        proposalId: r.approval.proposalId,
        shownHash: r.approval.shownHash,
        decision: "approved",
        ownerId: OWNER_ID,
        decidedAt: now().toISOString(),
      });
      outcome = `owner approved, ${decided.execution?.status ?? decided.error ?? "?"}`;
    } else if (r.execution) {
      outcome = r.execution.status;
    }
    steps.push({ step: "buy at 2 cents", outcome, ...moved(engine, before) });
  }

  // 2. The provider raises its price.
  world.upstream.setPrice(UPSTREAM_PRICE_AFTER.cents);
  const atFour = await controller.submit(buy(UPSTREAM_PRICE_AFTER.cents));
  const failedRules = atFour.decision?.rules.checks.filter((c) => !c.pass).map((c) => c.rule);
  steps.push({
    step: "price now 4 cents: buy at 4",
    outcome: `${atFour.blockedBy ?? "not blocked"} (${(failedRules ?? []).join(", ")})`,
    moneyMoved: false,
  });

  // 3. An agent claiming the old price: our rules pass it, the rail sees the seller asks 4.
  const before = paidCount();
  const lied = await controller.submit(buy(UPSTREAM_PRICE_BEFORE.cents));
  steps.push({
    step: "agent claims 2 cents anyway",
    outcome: `${lied.blockedBy ?? "not blocked"} (${lied.execution?.detail ?? ""})`,
    ...moved(engine, before),
  });

  // 4. Around Warrant: only the mandate on chain is left to say no.
  const direct = classifyPay(await world.payAround(sourcingCredential(engine)));
  steps.push({
    step: "limits only (no Warrant): pay at 4",
    outcome: direct.kind === "refused" ? `chain refused: ${direct.reason}` : direct.kind,
    moneyMoved: direct.kind === "paid",
    ...(direct.kind === "paid" && direct.tx ? { tx: direct.tx } : {}),
  });
  return steps;
}

/**
 * Kit 11 beat, after the price rise: treasury proposes a 4-cent cap for sourcing; the owner
 * approves exactly that; the mandate is replaced and the next warrant version signed. 4-cent
 * purchases then go through, and the old credential is refused on chain (mandate_revoked).
 */
export async function limitChangeScene(
  now = () => new Date(),
  engine = createEngine({ scenario: "none", clock: now }),
): Promise<SceneStep[]> {
  const steps = await priceRiseScene(now, engine);
  const { controller, world } = engine;
  const oldCredential = sourcingCredential(engine);
  const target = world.warrants.get(AGENTS.sourcing.warrantId);
  if (!target) throw new Error("no sourcing warrant");

  const proposed = controller.proposeBudgetChange({
    proposalId: "bcp_scene_1",
    warrantId: target.warrantId,
    agentId: AGENTS.treasury.agentId,
    newTotalBudget: target.totalBudget,
    newPerPaymentCap: UPSTREAM_PRICE_AFTER,
    justification: "upstream now charges 4 cents",
    createdAt: now().toISOString(),
  });
  steps.push({
    step: "treasury proposes a 4-cent cap",
    outcome: proposed.ok ? "waiting for the owner" : (proposed.problems ?? []).join("; "),
    moneyMoved: false,
  });
  const decided = await controller.decideApproval({
    approvalId: "apr_bcp_scene_1",
    proposalId: "bcp_scene_1",
    shownHash: proposed.approval?.shownHash ?? "",
    decision: "approved",
    ownerId: OWNER_ID,
    decidedAt: now().toISOString(),
  });
  steps.push({
    step: "owner approves",
    outcome: decided.ok
      ? `mandate replaced, warrant v${decided.warrant?.version ?? "?"} signed`
      : (decided.error ?? "failed"),
    moneyMoved: false,
  });

  const before = world.settled().length;
  let r = await controller.submit({
    proposalId: "prop_scene_after",
    warrantId: target.warrantId,
    agentId: AGENTS.sourcing.agentId,
    agentRole: "sourcing",
    rail: "metal_x402",
    payeeId: "pay_upstream",
    amount: UPSTREAM_PRICE_AFTER,
    category: "data_purchase",
    recurrence: "one_off",
    idempotencyKey: "scene-limit-change-1",
    justification: "hourly forecast batch",
    createdAt: now().toISOString(),
  });
  // The purpose check flags the first purchase at the new price (+100%); the owner says yes once.
  let tapped = "";
  if (r.approval) {
    r = await controller.decideApproval({
      approvalId: "apr_prop_scene_after",
      proposalId: r.approval.proposalId,
      shownHash: r.approval.shownHash,
      decision: "approved",
      ownerId: OWNER_ID,
      decidedAt: now().toISOString(),
    });
    tapped = "owner approved, ";
  }
  steps.push({
    step: "buy at 4 cents under the new limits",
    outcome: tapped + (r.execution?.status ?? r.blockedBy ?? r.error ?? "error"),
    ...moved(engine, before),
  });

  const old = classifyPay(await world.payAround(oldCredential));
  steps.push({
    step: "old credential tries to pay",
    outcome: old.kind === "refused" ? `chain refused: ${old.reason}` : old.kind,
    moneyMoved: old.kind === "paid",
  });
  return steps;
}

const said = (f: DisputeFile) =>
  f.findings
    .map((x) =>
      x.decision.refund.cents > 0
        ? `${x.orderId} refund ${x.decision.refund.cents}c (${x.decision.reason})`
        : `${x.orderId} no refund (${x.decision.reason})`,
    )
    .join("; ");

/** The disputed orders. The mock world's three by default; the live scene's on testnet. */
export interface DisputeOrders {
  /** Served from a bad batch: refunded. */
  bad: string;
  /** Served from a good batch: stands. */
  good: string;
  /** Disputed as "my agent never agreed". */
  authorized: string;
  /** The account that paid for them. Default: the mock world's customer. */
  customer?: string;
  /** Makes refund payment ids unique per run (testnet `mandate pull --payment-id`). */
  run?: string;
}

const MOCK_ORDERS: DisputeOrders = { bad: "ord_1", good: "ord_2", authorized: "ord_3" };

/** Per order: the on-chain check and, when there is one, the settlement's explorer link. */
function evidenceNotes(engine: Engine, f: DisputeFile): string[] {
  return f.findings.flatMap((x) => {
    const first = x.evidence[0];
    const tx = engine.world.orders().get(x.orderId)?.txHash;
    if (!first) return [];
    return [`${x.orderId}: ${first.what}${tx ? ` ${explorerTx(tx)}` : ""}`];
  });
}

/**
 * Kit 11 beat, Metal's ask (ADR-012): a customer disputes. The store decides from evidence alone
 * and refunds by `mandate pull` only what the evidence supports:
 *   1. "the data was wrong" on two orders: one came from a bad batch (refund), one did not (stands)
 *   2. support refunds the bad one: 5 cents back to the order's payer, no owner tap (ADR-013)
 *   3. a follow-up ticket asks again, plus an order that never existed: nothing to refund
 *   4. support tries the same refund anyway: our rules refuse it (one refund per order)
 *   5. "my agent never agreed to this one": the customer's own owner signed the pass, so it stands
 */
export async function disputeScene(
  now = () => new Date(),
  engine = createEngine({ scenario: "none", clock: now }),
  o: DisputeOrders = MOCK_ORDERS,
): Promise<SceneStep[]> {
  const { controller, world } = engine;
  const steps: SceneStep[] = [];
  const customer = o.customer ? { customer: o.customer } : {};

  const first = await answerDispute(
    engine,
    { disputeId: "dsp_scene_1", orderIds: [o.bad, o.good], claim: "wrong_data", ...customer },
    now(),
  );
  steps.push({
    step: "customer: the data was wrong",
    outcome: said(first),
    moneyMoved: false,
    notes: evidenceNotes(engine, first),
  });

  let n = 0;
  const refund = (file: DisputeFile, orderId: string, cents: number): PaymentProposal => ({
    proposalId: `prop_refund_${++n}`,
    warrantId: AGENTS.support.warrantId,
    agentId: AGENTS.support.agentId,
    agentRole: "support",
    rail: "metal_x402",
    payeeId: "customer",
    amount: { currency: "USDZ", cents },
    category: "customer_refund",
    recurrence: "one_off",
    refundOfOrderId: orderId,
    sourceRef: file.ticketRef,
    idempotencyKey: `scene-dispute-refund-${o.run ? `${o.run}-` : ""}${n}`,
    justification: "the store's dispute file says refund",
    createdAt: now().toISOString(),
  });

  for (const f of first.findings.filter((x) => x.decision.refund.cents > 0)) {
    const before = world.settled().length;
    const r = await controller.submit(refund(first, f.orderId, f.decision.refund.cents));
    steps.push({
      step: `support refunds ${f.orderId} (mandate pull)`,
      outcome: r.execution?.status ?? r.blockedBy ?? (r.approval ? "waiting for the owner" : "?"),
      ...moved(engine, before),
    });
  }

  const again = await answerDispute(
    engine,
    { disputeId: "dsp_scene_2", orderIds: [o.bad, "ord_404"], claim: "wrong_data", ...customer },
    now(),
  );
  steps.push({
    step: "customer asks again, adds ord_404",
    outcome: said(again),
    moneyMoved: false,
  });

  const before = world.settled().length;
  const price = world.orders().get(o.bad)?.price.cents ?? 5;
  const twice = await controller.submit(refund(again, o.bad, price));
  const failedRules = twice.decision?.rules.checks.filter((c) => !c.pass).map((c) => c.rule);
  steps.push({
    step: `support tries to refund ${o.bad} again`,
    outcome: `${twice.blockedBy ?? "not blocked"} (${(failedRules ?? []).join(", ")})`,
    ...moved(engine, before),
  });

  const denied = await answerDispute(
    engine,
    { disputeId: "dsp_scene_3", orderIds: [o.authorized], claim: "not_authorized", ...customer },
    now(),
  );
  const ev = denied.findings[0]?.evidence ?? [];
  steps.push({
    step: "customer: my agent never agreed",
    outcome: `${said(denied)}: ${ev.filter((e) => e.ok).length} of ${ev.length} checks hold`,
    moneyMoved: false,
    notes: ev.map((e) => `${e.ok ? "holds" : "FAILS"}: ${e.what}`),
  });
  return steps;
}

function sourcingCredential(engine: Engine): string {
  const c = engine.world.credentials.get("sourcing");
  if (!c) throw new Error("no sourcing credential");
  return c;
}
