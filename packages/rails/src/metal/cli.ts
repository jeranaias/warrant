import { execFile } from "node:child_process";
import { usdzToCents } from "./units.js";

/**
 * Wrapper around the pinned `metal-agent` CLI (0.3.3, ADR-010). Its printed `key value` lines
 * are our contract with it; parser tests use output taken from the docs and real runs.
 * Never logs or returns key material: we only ever pass file paths, never their contents.
 */

export interface CliResult {
  code: number;
  stdout: string;
  stderr: string;
  timedOut: boolean;
}

export type CliRunner = (args: readonly string[], timeoutMs: number) => Promise<CliResult>;

/** Runs the CLI with execFile (no shell, so no injection through arguments). */
export function execCliRunner(
  bin = "metal-agent",
  env: NodeJS.ProcessEnv = process.env,
): CliRunner {
  return (args, timeoutMs) =>
    new Promise((resolve) => {
      execFile(
        bin,
        [...args],
        { timeout: timeoutMs, env, windowsHide: true, maxBuffer: 1024 * 1024 },
        (err, stdout, stderr) => {
          resolve({
            code: err ? (typeof err.code === "number" ? err.code : 1) : 0,
            stdout: String(stdout),
            stderr: String(stderr),
            timedOut: Boolean(err?.killed),
          });
        },
      );
    });
}

/** First word is the key, the rest of the line is the value. Repeated keys keep the first. */
export function parseKv(text: string): Map<string, string> {
  const out = new Map<string, string>();
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line) continue;
    const sp = line.indexOf(" ");
    const key = sp < 0 ? line : line.slice(0, sp);
    const value = sp < 0 ? "" : line.slice(sp + 1).trim();
    if (!out.has(key)) out.set(key, value);
  }
  return out;
}

/** "0.01 *USDZ" -> 1 */
export function parseAmountCents(value: string | undefined): number | undefined {
  if (!value) return undefined;
  const m = /^([\d.]+)\s*\*?USDZ\b/.exec(value);
  return m?.[1] ? usdzToCents(m[1]) : undefined;
}

const REFUSAL = /\b(mandate_[a-z_]+|transfer_would_fail)\b/;

export type MetalOutcome =
  | { kind: "paid"; tx?: string; amountCents?: number; nonce?: string; signedOffer?: string }
  | { kind: "refused"; reason: string }
  | { kind: "pending"; nonce?: string; detail: string }
  | { kind: "held"; detail: string }
  | { kind: "unknown"; nonce?: string; detail: string };

/**
 * `metal-agent pay <url> --mandate <cred>`. A signed payment whose answer was lost must never be
 * reported as failed: it may have settled (docs: "a payment was signed and may have settled").
 */
export function classifyPay(r: CliResult): MetalOutcome {
  const kv = parseKv(r.stdout);
  const nonce = kv.get("nonce");
  const all = `${r.stdout}\n${r.stderr}`;
  const withNonce = nonce ? { nonce } : {};
  if (r.timedOut) return { kind: "unknown", ...withNonce, detail: "timed out" };
  if (/may have settled|payment in doubt|payment unconfirmed/.test(all)) {
    return { kind: "unknown", ...withNonce, detail: "signed; outcome not known" };
  }
  if (/payment refused/.test(all) && /nothing was (paid|signed)/.test(all)) {
    return { kind: "refused", reason: REFUSAL.exec(all)?.[1] ?? firstErrorLine(r.stderr) };
  }
  if (/nothing was signed|Failed to create payment payload/.test(all)) {
    return { kind: "refused", reason: firstErrorLine(r.stderr) };
  }
  const status = kv.get("status");
  const tx = kv.get("transaction");
  if (r.code === 0 && status && /^2\d\d$/.test(status) && tx) {
    const amountCents = parseAmountCents(kv.get("amount"));
    const signedOffer = kv.get("signed-offer");
    return {
      kind: "paid",
      tx,
      ...withNonce,
      ...(amountCents === undefined ? {} : { amountCents }),
      ...(signedOffer ? { signedOffer } : {}),
    };
  }
  // Anything else after signing could have moved money; before signing it could not.
  return nonce
    ? { kind: "unknown", nonce, detail: firstErrorLine(r.stderr) || `exit ${r.code}` }
    : { kind: "refused", reason: firstErrorLine(r.stderr) || `exit ${r.code}` };
}

/**
 * `metal-agent mandate pull --payment-id <id>`. Exit 0 paid, 1 refused, 3 pending, 4 held.
 * A retry with the same payment id pays at most once ("already paid, nothing sent").
 */
export function classifyPull(r: CliResult): MetalOutcome {
  const kv = parseKv(r.stdout);
  const all = `${r.stdout}\n${r.stderr}`;
  if (r.timedOut) return { kind: "unknown", detail: "timed out; re-run with the same payment id" };
  const tx = kv.get("transaction");
  const outcome = kv.get("outcome") ?? "";
  if (r.code === 0 && (outcome.startsWith("paid") || /already paid/.test(all))) {
    const amountCents = parseAmountCents(kv.get("amount"));
    return {
      kind: "paid",
      ...(tx ? { tx } : {}),
      ...(amountCents === undefined ? {} : { amountCents }),
    };
  }
  if (r.code === 3 || outcome.startsWith("pending")) return { kind: "pending", detail: "pending" };
  if (r.code === 4 || outcome.startsWith("held")) {
    return { kind: "held", detail: "held in escrow; counts against budget; do not resend" };
  }
  const reason = REFUSAL.exec(all)?.[1];
  if (r.code === 1 && (outcome.startsWith("refused") || reason)) {
    return { kind: "refused", reason: reason ?? firstErrorLine(r.stderr) };
  }
  // Any other error may have happened after submitting. Re-running the same id is safe.
  return { kind: "unknown", detail: firstErrorLine(r.stderr) || `exit ${r.code}` };
}

function firstErrorLine(stderr: string): string {
  const line = stderr.split(/\r?\n/).find((l) => l.trim()) ?? "";
  // Never echo file paths (credential locations) or long hex blobs back up the stack.
  return line
    .replace(/^error:\s*/, "")
    .replace(/\S*[/\\]\S*/g, "<path>")
    .replace(/0x[0-9a-fA-F]{66,}/g, "<hex>")
    .slice(0, 200);
}
