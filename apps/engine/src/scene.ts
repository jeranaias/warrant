import { AGENT_BUDGETS } from "@warrant/control";
import { liveConfigFromEnv, loadEnv, railsMode } from "./config.js";
import { makeLiveWorld } from "./live.js";
import { limitChangeScene } from "./scenes.js";
import { createEngine } from "./server.js";
import type { Engine } from "./server.js";
import { AGENTS } from "./world.js";

/**
 * `pnpm scene`: the price rises from 2 cents to 4 and is refused; then the owner approves
 * treasury's new 4-cent cap and buying resumes. Prints each step.
 *
 * RAILS_MODE=sandbox plays it on Metal testnet: real payments, real refusals, and the sourcing
 * mandate really replaced (4-cent cap). Run `pnpm reset:live` before the next rehearsal.
 */
loadEnv();
const now = () => new Date();
let close = async () => {};
let engine: Engine | undefined;
if (railsMode() === "sandbox") {
  const world = await makeLiveWorld(liveConfigFromEnv());
  const cap = world.warrants.get(AGENTS.sourcing.warrantId)?.perPaymentCap.cents;
  if (cap !== AGENT_BUDGETS.sourcing.perPaymentCap.cents) {
    throw new Error(
      `sourcing's mandate cap is ${cap} cents, not the day-one ${AGENT_BUDGETS.sourcing.perPaymentCap.cents}: run pnpm reset:live first`,
    );
  }
  ({ close } = await world.listen());
  engine = createEngine({ scenario: "none", clock: now, world });
  console.log("Metal testnet (RAILS_MODE=sandbox); Airwallex stays on the mock rail\n");
}

try {
  const steps = await limitChangeScene(now, engine);
  for (const s of steps) {
    const label = s.moneyMoved ? "PAID   " : s.blocked ? "BLOCKED" : "       ";
    console.log(`${label}  ${s.step.padEnd(36)} ${s.outcome}`);
    if (s.tx && railsMode() === "sandbox") {
      console.log(`         ${"".padEnd(36)} https://testnet.metalntwx.com/tx/${s.tx}`);
    }
  }
} finally {
  await close();
}
