import { resolve } from "node:path";
import { railsMode } from "./config.js";
import { hostedEngine, startAgents } from "./hosted-agents.js";
import { hostedApp } from "./hosted-app.js";

/**
 * The hosted demo (issue #89, docs/RUNBOOK.md "Hosted demo"): the built dashboard plus one mock
 * engine per signed-in visitor, on PORT, with that visitor's three agents running inside it. Mock
 * rails always; scripted agents and the deterministic purpose check unless a visitor pastes their
 * own Anthropic key (ADR-023), which only that visitor's session uses. Needs DEMO_PASSWORD and DEMO_COOKIE_SECRET; refuses to start without them.
 * `pnpm engine` (main.ts) stays the local way to run.
 */

function fail(message: string): never {
  console.error(`hosted demo not started: ${message}`);
  process.exit(1);
}

if (railsMode() !== "mock") fail("the hosted demo runs on mock rails only (RAILS_MODE=mock)");
const password = process.env["DEMO_PASSWORD"] ?? "";
const cookieSecret = process.env["DEMO_COOKIE_SECRET"] ?? "";
if (!password) fail("set DEMO_PASSWORD (the access code judges type in)");
if (cookieSecret.length < 16) fail("set DEMO_COOKIE_SECRET (16+ characters)");

const port = Number(process.env["PORT"] ?? 10000);
const distDir = resolve(process.env["DASHBOARD_DIST"] ?? "apps/dashboard/dist");

const hosted = hostedApp({
  password,
  cookieSecret,
  distDir,
  makeEngine: hostedEngine,
  startAgents: (engine, model) => startAgents(engine, model ? { model } : {}),
  // Render serves *.onrender.com through Cloudflare, which sets this header and overwrites a
  // client's copy. Set CLIENT_IP_HEADER="" on a host without such an edge.
  clientIpHeader: process.env["CLIENT_IP_HEADER"] ?? "cf-connecting-ip",
});

const server = hosted.app.listen(port, "0.0.0.0", () => {
  console.log(
    `hosted demo on port ${port} (open http://localhost:${port}), mock rails, dashboard from ${distDir}`,
  );
});

function shutdown(): void {
  hosted.close();
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 5_000).unref();
}
process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);
