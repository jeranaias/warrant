import { purposeFromEnv } from "@warrant/control";
import { liveConfigFromEnv, loadEnv, railsMode } from "./config.js";
import { makeLiveWorld } from "./live.js";
import { createEngine } from "./server.js";

/**
 * Starts the engine on ENGINE_PORT (default 4000). Mock rails by default. RAILS_MODE=sandbox runs
 * the Metal rail on testnet and starts the upstream provider (UPSTREAM_PORT) and our store
 * (STORE_PORT) next to it; see docs/TESTNET.md "Running live".
 */
loadEnv();
const port = Number(process.env["ENGINE_PORT"] ?? 4000);
const live = railsMode() === "sandbox";
const world = live ? await makeLiveWorld(liveConfigFromEnv()) : undefined;
if (world) await world.listen();
// Lane A's purpose check: the model when ANTHROPIC_API_KEY is set, else the deterministic one.
const { app } = createEngine({ purpose: purposeFromEnv(), ...(world ? { world } : {}) });
app.listen(port, "127.0.0.1", () => {
  const mode = live ? "Metal testnet, Airwallex mock" : "mock rails";
  console.log(
    `engine on http://127.0.0.1:${port}, ${mode} (GET /tasks?role=sourcing, POST /proposals)`,
  );
});
