import type { SignedOrderRecord } from "@warrant/contracts";
import type { CustomerBuyer } from "./customer.js";
import type { LiveWorld } from "./live.js";
import { disputeScene } from "./scenes.js";
import type { SceneStep } from "./scenes.js";
import type { Engine } from "./server.js";

/**
 * The dispute beat on Metal testnet (RAILS_MODE=sandbox pnpm scene:dispute):
 *   1. the customer's agent buys two queries from our store, each with a signed order and a
 *      warrant pass under its owner's grant; the store checks the pass, serves, and stores the order
 *   2. the store learns the batch behind the first one was stale
 *   3. then the same steps as the mock scene, on these two orders: the store checks each
 *      settlement on chain (metal-pay `verifyMandatePayment`), refunds the bad one by support's
 *      `mandate pull`, refuses a second refund, and stands by the order the customer's owner signed
 */
export async function liveDisputeScene(
  now: () => Date,
  engine: Engine,
  world: LiveWorld,
  buyer: CustomerBuyer,
): Promise<SceneStep[]> {
  const steps: SceneStep[] = [];
  const bought: SignedOrderRecord[] = [];
  for (const item of ["fx-eurusd", "btc-usd"]) {
    const r = await buyer.buy(item);
    const order = r.tx ? await orderFor(world, r.tx) : undefined;
    steps.push({
      step: `customer's agent buys ${item}`,
      outcome: order ? `paid, store kept signed order ${order.orderId}` : r.outcome,
      moneyMoved: r.tx !== undefined,
      ...(r.tx ? { tx: r.tx } : {}),
    });
    if (!order) {
      const why = r.tx ? "paid, but the store kept no order for it" : "the purchase did not settle";
      steps.push({ step: "scene stopped", outcome: why, moneyMoved: false });
      return steps;
    }
    bought.push(order);
  }

  const [bad, good] = bought;
  const batch = bad?.upstreamBatchId;
  if (!bad || !good || !batch) {
    steps.push({
      step: "scene stopped",
      outcome: "no batch recorded on the order",
      moneyMoved: false,
    });
    return steps;
  }
  world.markBatchBad(batch);
  steps.push({
    step: `store: batch ${batch} was stale`,
    outcome: `orders served from it are refundable`,
    moneyMoved: false,
  });

  const rest = await disputeScene(now, engine, {
    bad: bad.orderId,
    good: good.orderId,
    authorized: good.orderId,
    customer: buyer.address,
    run: String(now().getTime()),
  });
  return [...steps, ...rest];
}

/** The store writes the order in its after-settle hook; give it a moment. */
async function orderFor(
  world: LiveWorld,
  tx: string,
  tries = 20,
): Promise<SignedOrderRecord | undefined> {
  for (let i = 0; i < tries; i++) {
    const o = [...world.orders().values()].find((x) => x.txHash.toLowerCase() === tx.toLowerCase());
    if (o) return o;
    await new Promise((r) => setTimeout(r, 500));
  }
  return undefined;
}
