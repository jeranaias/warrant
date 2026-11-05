import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";

/**
 * Engine settings from the environment. `RAILS_MODE=mock` (default) needs nothing.
 * `RAILS_MODE=sandbox` runs the Metal rail on the real testnet with the owner's METAL_HOME, and
 * when AIRWALLEX_BASE_URL, AIRWALLEX_CLIENT_ID and AIRWALLEX_API_KEY are all set, runs the
 * Airwallex transfer rail on the Airwallex sandbox (otherwise Airwallex stays on the mock rail).
 */

export type RailsMode = "mock" | "sandbox";

export interface AirwallexConfig {
  baseUrl: string;
  clientId: string;
  apiKey: string;
}

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
  /**
   * Airwallex sandbox credentials, present only when AIRWALLEX_BASE_URL, AIRWALLEX_CLIENT_ID and
   * AIRWALLEX_API_KEY are all set. Never logged, returned or passed to the Metal CLI.
   */
  airwallex?: AirwallexConfig;
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

const LIVE_VARS = [
  "METAL_HOME",
  "METAL_RPC_URL",
  "METAL_STORE_ADDRESS",
  "METAL_UPSTREAM_ADDRESS",
] as const;

function withPublicEnv(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const home = env["METAL_HOME"]?.trim();
  if (!home) return env;
  const pub = join(home, "warrant-public.env");
  if (!existsSync(pub)) return env;
  const merged: NodeJS.ProcessEnv = { ...env };
  for (const line of readFileSync(pub, "utf8").split(/\r?\n/)) {
    const m = /^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/.exec(line);
    if (!m?.[1] || merged[m[1]] !== undefined) continue;
    const value = (m[2] ?? "").replace(/^["']|["']$/g, "");
    if (value) merged[m[1]] = value;
  }
  return merged;
}

export interface EngineRailsOptions {
  /** True when started as `pnpm live` (`--agents`): auto-picks sandbox when settings exist. */
  live?: boolean;
  agents?: boolean;
}

/**
 * Rails choice for `pnpm engine` and `pnpm live` (`--agents`).
 *
 * - Plain `pnpm engine` (`live` false): mock unless `RAILS_MODE=sandbox` is set explicitly.
 * - `pnpm live` (`live` true): `RAILS_MODE=mock` stays mock; otherwise (unset, `auto`, or
 *   `sandbox`) uses Metal testnet when `METAL_HOME`, `METAL_RPC_URL`, `METAL_STORE_ADDRESS` and
 *   `METAL_UPSTREAM_ADDRESS` (in `env` or `METAL_HOME/warrant-public.env`) are all present, and
 *   falls back to mock naming the missing settings (names only, never values) when any is missing.
 */
export function engineRailsMode(
  env: NodeJS.ProcessEnv = process.env,
  opts: boolean | EngineRailsOptions = false,
): {
  mode: RailsMode;
  why: string;
} {
  const live = typeof opts === "boolean" ? opts : Boolean(opts.live ?? opts.agents);
  const asked = (env["RAILS_MODE"] ?? "").trim().toLowerCase();
  if (asked === "mock") return { mode: "mock", why: "RAILS_MODE=mock" };
  if (asked !== "" && asked !== "auto" && asked !== "sandbox") {
    throw new Error("RAILS_MODE must be mock, sandbox or auto");
  }
  if (!live) {
    return asked === "sandbox"
      ? { mode: "sandbox", why: "RAILS_MODE=sandbox" }
      : {
          mode: "mock",
          why: asked === "auto" ? "RAILS_MODE=auto (plain engine uses mock)" : "default (mock)",
        };
  }
  const full = withPublicEnv(env);
  const missing = LIVE_VARS.filter((k) => !full[k]?.trim());
  if (missing.length > 0) {
    return {
      mode: "mock",
      why: `no ${missing.join(", ")} (RAILS_MODE=${asked || "auto"})`,
    };
  }
  return {
    mode: "sandbox",
    why: asked === "sandbox" ? "RAILS_MODE=sandbox" : "testnet settings found (pnpm live)",
  };
}

// process.env lookups are case-insensitive on Windows, so "PATH" also finds "Path".
const OS_VARS = ["PATH", "SYSTEMROOT", "TEMP", "TMP", "HOME", "USERPROFILE", "APPDATA"];
const CLI_VARS = ["METAL_RPC_URL", "METAL_FAUCET_URL", "METAL_FACILITATOR_URL"];

/**
 * Reads Airwallex sandbox settings when all three of AIRWALLEX_BASE_URL, AIRWALLEX_CLIENT_ID and
 * AIRWALLEX_API_KEY are non-empty; otherwise undefined. Never logs or echoes values.
 */
export function airwallexConfigFromEnv(
  env: NodeJS.ProcessEnv = process.env,
): AirwallexConfig | undefined {
  const baseUrl = env["AIRWALLEX_BASE_URL"]?.trim().replace(/\/$/, "");
  const clientId = env["AIRWALLEX_CLIENT_ID"]?.trim();
  const apiKey = env["AIRWALLEX_API_KEY"]?.trim();
  if (!baseUrl || !clientId || !apiKey) return undefined;
  return { baseUrl, clientId, apiKey };
}

export function liveConfigFromEnv(env: NodeJS.ProcessEnv = process.env): LiveConfig {
  const full = withPublicEnv(env);
  const need = (k: string): string => {
    const v = full[k]?.trim();
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
  for (const k of CLI_VARS) if (full[k]) cliEnv[k] = full[k];
  const airwallex = airwallexConfigFromEnv(full);
  return {
    bin: full["METAL_AGENT_BIN"] ?? (existsSync(shipped) ? shipped : "metal-agent"),
    cliEnv,
    home,
    rpcUrl,
    ...(full["METAL_FACILITATOR_URL"] ? { facilitatorUrl: full["METAL_FACILITATOR_URL"] } : {}),
    business: need("METAL_STORE_ADDRESS"),
    upstream: need("METAL_UPSTREAM_ADDRESS"),
    ownerKey: full["METAL_OWNER_KEY_FILE"] ?? "business-owner.json",
    credentials: {
      sourcing: full["METAL_SOURCING_CREDENTIAL"] ?? "sourcing.json",
      support: full["METAL_SUPPORT_CREDENTIAL"] ?? "support.json",
    },
    upstreamPort: Number(full["UPSTREAM_PORT"] ?? 4022),
    storePort: Number(full["STORE_PORT"] ?? 4021),
    dataDir: full["WARRANT_DATA_DIR"] ?? join(home, "warrant-live"),
    ...(airwallex ? { airwallex } : {}),
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
