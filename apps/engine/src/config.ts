import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";

/**
 * Engine settings from the environment. `RAILS_MODE=mock` (default) needs nothing.
 * `RAILS_MODE=sandbox` runs the Metal rail on the real testnet with the owner's METAL_HOME;
 * Airwallex stays on the in-memory rail (there is no sandbox Airwallex adapter in rails yet).
 */

export type RailsMode = "mock" | "sandbox";

export interface LiveConfig {
  /** metal-agent 0.3.3: a `dist/index.js` path (run under node) or a binary on PATH. */
  bin: string;
  /** Environment the CLI gets: METAL_* and what the OS needs, never our other secrets. */
  cliEnv: NodeJS.ProcessEnv;
  home: string;
  rpcUrl: string;
  facilitatorUrl?: string;
  /** Business smart account: mandate principal and our store's payTo. */
  business: string;
  /** Simulated upstream provider's smart account: the payee on sourcing's mandate. */
  upstream: string;
  /** Owner key file inside METAL_HOME. */
  ownerKey: string;
  /** Day-one credential files inside METAL_HOME (the owner state names later versions). */
  credentials: { sourcing: string; support: string };
  upstreamPort: number;
  storePort: number;
  /** Outside the repo: owner state (current credential per agent) and stored orders. */
  dataDir: string;
}

/**
 * Minimal .env reader (no dependency): KEY=value lines; never logs values; never overrides what
 * is already set. Blank values are skipped: metal-agent treats an empty METAL_FACILITATOR_URL as
 * a bad URL instead of falling back to its default.
 */
export function loadDotEnv(file: string): void {
  if (!existsSync(file)) return;
  for (const line of readFileSync(file, "utf8").split(/\r?\n/)) {
    const m = /^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/.exec(line);
    if (!m?.[1] || process.env[m[1]] !== undefined) continue;
    const value = (m[2] ?? "").replace(/^["']|["']$/g, "");
    if (value) process.env[m[1]] = value;
  }
}

/**
 * WARRANT_ENV_FILE if set (e.g. another checkout's .env), then the repo's .env (run from the root
 * or from apps/engine), then METAL_HOME's public values. Earlier files win.
 */
export function loadEnv(): void {
  const file = process.env["WARRANT_ENV_FILE"];
  if (file) loadDotEnv(resolve(file));
  loadDotEnv(resolve(process.cwd(), ".env"));
  loadDotEnv(resolve(process.cwd(), "../../.env"));
  const home = process.env["METAL_HOME"];
  if (home) loadDotEnv(join(home, "warrant-public.env"));
}

export function railsMode(env: NodeJS.ProcessEnv = process.env): RailsMode {
  return env["RAILS_MODE"] === "sandbox" ? "sandbox" : "mock";
}

// process.env lookups are case-insensitive on Windows, so "PATH" also finds "Path".
const OS_VARS = ["PATH", "SYSTEMROOT", "TEMP", "TMP", "HOME", "USERPROFILE", "APPDATA"];
const CLI_VARS = ["METAL_RPC_URL", "METAL_FAUCET_URL", "METAL_FACILITATOR_URL"];

export function liveConfigFromEnv(env: NodeJS.ProcessEnv = process.env): LiveConfig {
  const need = (k: string): string => {
    const v = env[k];
    if (!v) throw new Error(`${k} is required for RAILS_MODE=sandbox (see docs/TESTNET.md)`);
    return v;
  };
  const home = need("METAL_HOME");
  const rpcUrl = need("METAL_RPC_URL");
  const shipped = join(
    home,
    "cli",
    "node_modules",
    "@metalntwx",
    "metal-agent",
    "dist",
    "index.js",
  );
  const cliEnv: NodeJS.ProcessEnv = {};
  for (const k of OS_VARS) if (process.env[k]) cliEnv[k] = process.env[k];
  for (const k of CLI_VARS) if (env[k]) cliEnv[k] = env[k];
  return {
    bin: env["METAL_AGENT_BIN"] ?? (existsSync(shipped) ? shipped : "metal-agent"),
    cliEnv,
    home,
    rpcUrl,
    ...(env["METAL_FACILITATOR_URL"] ? { facilitatorUrl: env["METAL_FACILITATOR_URL"] } : {}),
    business: need("METAL_STORE_ADDRESS"),
    upstream: need("METAL_UPSTREAM_ADDRESS"),
    ownerKey: env["METAL_OWNER_KEY_FILE"] ?? "business-owner.json",
    credentials: {
      sourcing: env["METAL_SOURCING_CREDENTIAL"] ?? "sourcing.json",
      support: env["METAL_SUPPORT_CREDENTIAL"] ?? "support.json",
    },
    upstreamPort: Number(env["UPSTREAM_PORT"] ?? 4022),
    storePort: Number(env["STORE_PORT"] ?? 4021),
    dataDir: env["WARRANT_DATA_DIR"] ?? join(home, "warrant-live"),
  };
}

/** The simulated customer on testnet (the live dispute scene's buyer). */
export interface CustomerConfig {
  /** The customer's smart account (`pnpm setup:testnet` writes it to warrant-public.env). */
  address: string;
  /** The customer agent's mandate credential file inside METAL_HOME. */
  credential: string;
}

/**
 * What the live dispute scene needs on top of `liveConfigFromEnv`. Checks the files exist (never
 * reads them) so a missing setup fails here, with the step to take, not halfway through a run.
 */
export function customerConfigFromEnv(
  cfg: LiveConfig,
  env: NodeJS.ProcessEnv = process.env,
): CustomerConfig {
  const see = 'see "Running live" in docs/TESTNET.md';
  if (!existsSync(cfg.home)) throw new Error(`METAL_HOME does not exist; ${see}`);
  if (!existsSync(join(cfg.home, cfg.ownerKey))) {
    throw new Error(`METAL_HOME has no ${cfg.ownerKey} (the business owner key); ${see}`);
  }
  const address = env["METAL_CUSTOMER_ADDRESS"];
  if (!address) {
    throw new Error(
      `METAL_CUSTOMER_ADDRESS is required for the live dispute scene: pnpm setup:testnet writes it ` +
        `to METAL_HOME/warrant-public.env; ${see}`,
    );
  }
  const credential = env["METAL_CUSTOMER_CREDENTIAL"] ?? "customer-agent.json";
  if (!/^[A-Za-z0-9._-]+\.json$/.test(credential)) {
    throw new Error("METAL_CUSTOMER_CREDENTIAL must be a plain file name inside METAL_HOME");
  }
  if (!existsSync(join(cfg.home, credential))) {
    throw new Error(`the customer's mandate credential ${credential} is not in METAL_HOME; ${see}`);
  }
  return { address, credential };
}
