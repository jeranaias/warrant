import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * The repo's `.env` for `pnpm agents` and `pnpm bench`, read by the same rules as the engine's
 * (`apps/engine/src/config.ts`): KEY=value lines, earlier files win, a variable already set is
 * never overridden, blank values are skipped, and nothing is ever printed. So a model key lives in
 * `.env` (gitignored) and never needs to be typed into a command.
 */
export function loadDotEnv(file: string, env: NodeJS.ProcessEnv = process.env): void {
  if (!existsSync(file)) return;
  for (const line of readFileSync(file, "utf8").split(/\r?\n/)) {
    const m = /^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/.exec(line);
    if (!m?.[1] || env[m[1]] !== undefined) continue;
    const value = (m[2] ?? "").replace(/^["']|["']$/g, "");
    if (value) env[m[1]] = value;
  }
}

/** The repository root, from this file's place in it (packages/agents/src). */
const REPO_ROOT = fileURLToPath(new URL("../../../", import.meta.url));

/** WARRANT_ENV_FILE if set, then `.env` in the current folder, then the repo root's `.env`. */
export function loadEnv(env: NodeJS.ProcessEnv = process.env): void {
  const file = env["WARRANT_ENV_FILE"];
  if (file) loadDotEnv(resolve(file), env);
  loadDotEnv(resolve(process.cwd(), ".env"), env);
  loadDotEnv(resolve(REPO_ROOT, ".env"), env);
}

/** A whole number from 1 to `max` from the environment, else `fallback`. Bad values throw. */
export function positiveInt(
  env: NodeJS.ProcessEnv,
  name: string,
  fallback: number,
  max = 100_000,
): number {
  const raw = env[name];
  if (raw === undefined || raw === "") return fallback;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 1 || n > max) {
    throw new Error(`${name} must be a whole number from 1 to ${max}`);
  }
  return n;
}
