import type { PaymentProposal } from "@warrant/contracts";
import { UPSTREAM_PRICE_AFTER, UPSTREAM_PRICE_BEFORE } from "@warrant/control";
import { classifyPay } from "@warrant/rails";
import { UPSTREAM_URL } from "@warrant/mocks/metal";
import { createEngine } from "./server.js";
import { AGENTS, OWNER_ID } from "./world.js";

/**
 * Kit 11 beat: the upstream price rises from 2 cents to 4, over sourcing's 3-cent cap.
 * Played on the mock chain, so the same story the testnet run tells (docs/TESTNET.md):
 *   1. purchases at 2 cents go through (the first one after the owner says yes)
 *   2. the price rises; the 4-cent purchase is refused by our rules, before any chain call
 *   3. an agent that claims the old price is refused by the rail: the seller now asks 4
 *   4. sent around Warrant ("limits only"), the chain's mandate refuses it: mandate_cap_exceeded
 */
export interface SceneStep {
  step: string;
  outcome: string;
  moneyMoved: boolean;
}

export async function priceRiseScene(now = () => new Date()): Promise<SceneStep[]> {
  const { controller, world } = createEngine({ scenario: "none", clock: now });
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
  const paidCount = () => world.chain.txs.length;

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
    steps.push({ step: "buy at 2 cents", outcome, moneyMoved: paidCount() > before });
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
    moneyMoved: paidCount() > before,
  });

  // 4. Around Warrant: only the mandate on chain is left to say no.
  const run = world.chain.runner();
  const direct = classifyPay(
    await run(["pay", UPSTREAM_URL, "--mandate", "sourcing.json"], 60_000),
  );
  steps.push({
    step: "limits only (no Warrant): pay at 4",
    outcome: direct.kind === "refused" ? `chain refused: ${direct.reason}` : direct.kind,
    moneyMoved: direct.kind === "paid",
  });
  return steps;
}
