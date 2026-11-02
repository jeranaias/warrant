import { randomBytes } from "node:crypto";
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
 *
 * SCENE_ENGINE_PORT=4000 also serves this run's engine API there (events, orders; owner actions
 * locked) and keeps it up after the scene until Ctrl+C, so the dashboard's Activity shows the
 * store's pass checks and dispute decisions.
 */
loadEnv();
const live = railsMode() === "sandbox";
const servePort = process.env["SCENE_ENGINE_PORT"];
const now = () => new Date();
let close = async () => {};
let steps: SceneStep[];
try {
  const cfg = live ? liveConfigFromEnv() : undefined;
  const customer = cfg ? customerConfigFromEnv(cfg) : undefined;
  const world = cfg ? await makeLiveWorld(cfg) : undefined;
  if (world) ({ close } = await world.listen());
  const engine = createEngine({
    scenario: "none",
    clock: now,
    ownerToken: randomBytes(18).toString("base64url"),
    ...(world ? { world } : {}),
  });
  if (servePort) {
    engine.app.listen(Number(servePort), "127.0.0.1");
    console.log(`engine API for this run on http://127.0.0.1:${servePort} (Ctrl+C to stop)`);
  }
  if (world && customer) {
    const buyer = await world.customer(customer, now);
    console.log("Metal testnet (RAILS_MODE=sandbox); Airwallex stays on the mock rail");
    console.log(`customer ${buyer.address}, mandate ${buyer.mandateId}\n`);
    steps = await liveDisputeScene(now, engine, world, buyer);
  } else {
    steps = await disputeScene(now, engine);
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
