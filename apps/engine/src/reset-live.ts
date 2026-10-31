import { AGENT_BUDGETS } from "@warrant/control";
import { liveConfigFromEnv, loadEnv } from "./config.js";
import { makeLiveWorld } from "./live.js";

/**
 * `pnpm reset:live`: the owner puts sourcing's mandate back on day-one limits (ADR-009: 3-cent
 * cap, 10 USDZ budget) with `mandate replace`, a new version, never a rewrite. Run it after a live
 * `pnpm scene`, which leaves sourcing on a 4-cent cap. The replaced credential stays in
 * METAL_HOME (refused on chain as mandate_revoked); owner-state.json names the new one.
 */
loadEnv();
const world = await makeLiveWorld(liveConfigFromEnv());
const day1 = AGENT_BUDGETS.sourcing;
const now = await world.resetSourcing();
console.log(
  now
    ? `sourcing: mandate replaced (cap ${day1.perPaymentCap.cents}c, budget ${day1.budget.cents}c); current credential ${now}`
    : "sourcing is already on day-one limits; nothing changed on chain",
);
