import { customerConfigFromEnv, liveConfigFromEnv, loadEnv, railsMode } from "./config.js";
import { liveDisputeScene } from "./dispute-live.js";
import { makeLiveWorld } from "./live.js";
import { disputeScene, explorerTx } from "./scenes.js";
import type { SceneStep } from "./scenes.js";
import { createEngine } from "./server.js";

/**
 * `pnpm scene:dispute`: a customer disputes; the store decides from its signed orders, the
 * settlement and the customer's warrant pass; support refunds the one bad order by `mandate pull`
 * and nothing else. Mock chain by default.
 *
 * RAILS_MODE=sandbox plays it on Metal testnet: the customer's agent first buys two queries from
 * our store (signed order + warrant pass), and each disputed order's settlement is checked on
 * chain. Changes no mandate, so no `pnpm reset:live` is needed after it.
 */
loadEnv();
const live = railsMode() === "sandbox";
const now = () => new Date();
let close = async () => {};
let steps: SceneStep[];
try {
  if (live) {
    const cfg = liveConfigFromEnv();
    const customer = customerConfigFromEnv(cfg);
    const world = await makeLiveWorld(cfg);
    ({ close } = await world.listen());
    const engine = createEngine({ scenario: "none", clock: now, world });
    const buyer = await world.customer(customer, now);
    console.log("Metal testnet (RAILS_MODE=sandbox); Airwallex stays on the mock rail");
    console.log(`customer ${buyer.address}, mandate ${buyer.mandateId}\n`);
    steps = await liveDisputeScene(now, engine, world, buyer);
  } else {
    steps = await disputeScene();
  }
} finally {
  await close();
}

for (const s of steps) {
  console.log(`${s.moneyMoved ? "PAID   " : "       "}  ${s.step.padEnd(40)} ${s.outcome}`);
  if (!live) continue;
  const pad = "".padEnd(49);
  if (s.tx) console.log(`${pad}${s.tx}\n${pad}${explorerTx(s.tx)}`);
  for (const n of s.notes ?? []) console.log(`${pad}${n}`);
}
