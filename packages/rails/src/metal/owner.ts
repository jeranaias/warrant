import { join } from "node:path";
import type { CliRunner } from "./cli.js";
import { parseAmountCents, parseKv } from "./cli.js";
import { centsToUsdz } from "./units.js";

/**
 * Owner-side Metal operations (ADR-009): only the owner replaces or revokes a mandate, with the
 * owner key from METAL_HOME. Called after the owner approves a BudgetChangeProposal; no agent can
 * reach them. Arguments as verified live against testnet with metal-agent 0.3.3.
 */

export interface MandateLimits {
  capCents: number;
  budgetCents: number;
  /** Payee addresses the mandate may pay; empty = any (support refunds). */
  payees: string[];
  expiresInSeconds: number;
  description?: string;
}

/** A mandate as the chain reports it (`mandate status`). */
export interface MandateStatus {
  mandateId: string;
  capCents: number;
  budgetCents: number;
  spentCents: number;
  /** ISO time the mandate stops paying. */
  expiresAt: string;
  payees: string[];
  bound: boolean;
  revoked: boolean;
}

export interface MetalOwnerOps {
  /** Create a credential for the new limits and replace the old mandate with it. */
  replace(oldCredential: string, newCredential: string, limits: MandateLimits): Promise<string>;
  revoke(credential: string): Promise<void>;
  /** Read-only: what the chain says about this credential's mandate. */
  status(credential: string): Promise<MandateStatus>;
}

export interface CliOwnerOpsOptions {
  run: CliRunner;
  metalHome: string;
  rpcUrl: string;
  /** File name of the owner key inside METAL_HOME. */
  ownerKey: string;
  /** The owner's smart account (mandate principal). */
  principal: string;
  timeoutMs?: number;
}

const CRED_NAME = /^[A-Za-z0-9._-]+\.json$/;

export class CliMetalOwnerOps implements MetalOwnerOps {
  constructor(private readonly o: CliOwnerOpsOptions) {}

  async replace(oldCredential: string, newCredential: string, l: MandateLimits): Promise<string> {
    const oldPath = this.path(oldCredential);
    const newPath = this.path(newCredential);
    const create = [
      "mandate",
      "credential",
      "create",
      "--principal",
      this.o.principal,
      "--cap",
      centsToUsdz(l.capCents),
      "--budget",
      centsToUsdz(l.budgetCents),
      "--expires-in",
      String(l.expiresInSeconds),
      "--key",
      this.path(this.o.ownerKey),
      "--out",
      newPath,
      "--network",
      "testnet",
      ...l.payees.flatMap((p) => ["--payee", p]),
      ...(l.description ? ["--description", l.description] : []),
    ];
    const c = await this.o.run(create, this.timeout());
    if (c.code !== 0) throw new Error(`credential create failed: ${scrub(c.stderr)}`);
    const r = await this.o.run(
      [
        "mandate",
        "replace",
        "--credential",
        newPath,
        "--replaces",
        oldPath,
        "--key",
        this.path(this.o.ownerKey),
        "--network",
        "testnet",
        "--rpc-url",
        this.o.rpcUrl,
      ],
      this.timeout(),
    );
    // Windows: the CLI can crash on exit after succeeding (exit 127); trust its printed result.
    const kv = parseKv(`${c.stdout}\n${r.stdout}`);
    if (r.code !== 0 && !/replaced|bound/i.test(r.stdout)) {
      throw new Error(`mandate replace failed: ${scrub(r.stderr)}`);
    }
    return kv.get("bound") ?? kv.get("replaced") ?? kv.get("mandate") ?? newCredential;
  }

  async revoke(credential: string): Promise<void> {
    const r = await this.o.run(
      [
        "mandate",
        "revoke",
        "--credential",
        this.path(credential),
        "--key",
        this.path(this.o.ownerKey),
        "--network",
        "testnet",
        "--rpc-url",
        this.o.rpcUrl,
      ],
      this.timeout(),
    );
    if (r.code !== 0 && !/revoked/i.test(r.stdout)) {
      throw new Error(`mandate revoke failed: ${scrub(r.stderr)}`);
    }
  }

  async status(credential: string): Promise<MandateStatus> {
    const r = await this.o.run(
      [
        "mandate",
        "status",
        "--credential",
        this.path(credential),
        "--network",
        "testnet",
        "--rpc-url",
        this.o.rpcUrl,
      ],
      this.timeout(),
    );
    const s = parseMandateStatus(r.stdout);
    if (!s) throw new Error(`mandate status failed: ${scrub(r.stderr) || `exit ${r.code}`}`);
    return s;
  }

  private path(name: string): string {
    if (!CRED_NAME.test(name)) throw new Error("credential names are plain file names");
    return join(this.o.metalHome, name);
  }

  private timeout(): number {
    return this.o.timeoutMs ?? 120_000;
  }
}

function scrub(s: string): string {
  return (s.split(/\r?\n/).find((l) => l.trim()) ?? "")
    .replace(/\S*[/\\]\S*/g, "<path>")
    .slice(0, 200);
}

/**
 * `mandate status` output (0.3.3), e.g. `per-payment-cap 0.03 *USDZ`, `budget 10 *USDZ until
 * expiry`, `expiry 1795136704 (2026-11-20T01:05:04.000Z)`, `spent 0.03 *USDZ of 10 *USDZ`, one
 * `payee <address> <name>` line per payee, `bound yes`, `revoked no`.
 */
export function parseMandateStatus(stdout: string): MandateStatus | undefined {
  const kv = parseKv(stdout);
  const mandateId = kv.get("mandate");
  const capCents = parseAmountCents(kv.get("per-payment-cap"));
  const budgetCents = parseAmountCents(kv.get("budget"));
  const spentCents = parseAmountCents(kv.get("spent")) ?? 0;
  const expiry = /^(\d+)/.exec(kv.get("expiry") ?? "")?.[1];
  if (!mandateId || capCents === undefined || budgetCents === undefined || !expiry) {
    return undefined;
  }
  const payees = stdout
    .split(/\r?\n/)
    .map((l) => /^\s*payee\s+(0x[0-9a-fA-F]{40})\b/.exec(l)?.[1])
    .filter((a): a is string => a !== undefined);
  return {
    mandateId,
    capCents,
    budgetCents,
    spentCents,
    expiresAt: new Date(Number(expiry) * 1000).toISOString(),
    payees,
    bound: kv.get("bound") === "yes",
    revoked: kv.get("revoked") === "yes",
  };
}
