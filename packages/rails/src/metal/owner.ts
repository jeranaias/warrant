import { join } from "node:path";
import type { CliRunner } from "./cli.js";
import { parseKv } from "./cli.js";
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

export interface MetalOwnerOps {
  /** Create a credential for the new limits and replace the old mandate with it. */
  replace(oldCredential: string, newCredential: string, limits: MandateLimits): Promise<string>;
  revoke(credential: string): Promise<void>;
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
