import { randomBytes } from "node:crypto";
import { brainFromEnv } from "@warrant/agents";
import { purposeFromEnv } from "@warrant/control";
import { engineRailsMode, liveConfigFromEnv, loadEnv } from "./config.js";
import { startAgents } from "./hosted-agents.js";
import { liveModeLabel, makeLiveWorld } from "./live.js";
import { createEngine } from "./server.js";

/**
 * `pnpm engine`: the engine on ENGINE_PORT (default 4000).
 *
 * Rails (`engineRailsMode`): plain `pnpm engine` runs mock rails unless `RAILS_MODE=sandbox` is
 * set explicitly. `pnpm live` (`--agents`) uses Metal testnet when the testnet settings are in
 * .env and METAL_HOME (`RAILS_MODE` unset or `auto`), and falls back to mock naming any missing
 * settings when incomplete. On testnet the Airwallex transfer rail is the Airwallex sandbox when
 * its keys are in .env (#160), and the upstream provider (UPSTREAM_PORT) and our store
 * (STORE_PORT) start next to it; see docs/TESTNET.md "Running live".
 *
 * `pnpm live` (`--agents`): the three agents run inside the engine, so the dashboard's Run drives
 * them with no other process. They are the model when ANTHROPIC_API_KEY is in .env (capped at
 * AGENT_MAX_CALLS calls, default 100; AGENT_BRAIN=scripted keeps the script), the script
 * otherwise. Without `--agents`, run `pnpm agents` yourself, as before.
 */
loadEnv();
const port = Number(process.env["ENGINE_PORT"] ?? 4000);
const withAgents = process.argv.includes("--agents");
const rails = engineRailsMode(process.env, { live: withAgents });
const cfg = rails.mode === "sandbox" ? liveConfigFromEnv() : undefined;
const world = cfg ? await makeLiveWorld(cfg) : undefined;
if (world) await world.listen();
// Lane A's purpose check: the model when ANTHROPIC_API_KEY is set, else the deterministic one.
const purpose = purposeFromEnv();
// The owner's key for this run: approving and the emergency stop need it. A fresh one each start
// unless OWNER_TOKEN is set (e.g. for a hosted demo).
const ownerToken = process.env["OWNER_TOKEN"] || randomBytes(18).toString("base64url");
// With the agents inside, or on real rails, start with an empty queue: nothing is paid until
// someone presses Run. On mock rails without --agents, every scenario is queued for `pnpm agents`.
const engine = createEngine({
  purpose,
  ownerToken,
  ...(world ? { world } : {}),
  ...(withAgents || rails.mode === "sandbox" ? { scenario: "none" as const } : {}),
});

const agents = withAgents ? brainFromEnv() : undefined;
const driver = agents
  ? startAgents(engine, {
      brain: agents.brain,
      exhausted: () => {
        const u = agents.usage();
        return u !== undefined && u.calls >= u.max;
      },
    })
  : undefined;

engine.app.listen(port, "127.0.0.1", () => {
  const mode = liveModeLabel(cfg);
  console.log(
    `engine on http://127.0.0.1:${port}, ${mode} (GET /tasks?role=sourcing, POST /proposals)`,
  );
  console.log(`rails: ${rails.mode} (${rails.why}); purpose check: ${purpose.model}`);
  if (agents) {
    const cap = agents.usage();
    console.log(
      `agents: inside the engine, ${agents.brain.name}${cap ? `, at most ${cap.max} model calls` : ""}; press Run in the dashboard`,
    );
  }
  // localhost, not 127.0.0.1: Vite listens on "localhost", which can be IPv6 (::1) only.
  const dash = process.env["DASHBOARD_URL"] ?? "http://localhost:5173";
  console.log(`owner link (keep it to yourself): ${dash}/#/m?owner=${ownerToken}`);
});

const shutdown = () => {
  driver?.stop();
  agents?.done();
  const u = agents?.usage();
  if (u) console.log(`agents: ${u.calls} of ${u.max} model calls used`);
  process.exit(0);
};
process.once("SIGINT", shutdown);
process.once("SIGTERM", shutdown);
