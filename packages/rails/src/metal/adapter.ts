import { join } from "node:path";
import type { RailAdapter, RailInstruction, RailResult } from "../types.js";
import { classifyPay, classifyPull } from "./cli.js";
import type { CliRunner, MetalOutcome } from "./cli.js";
import { centsToUsdz } from "./units.js";

export interface MetalAdapterOptions {
  run: CliRunner;
  /** Folder outside the repo with mandate credentials + keys (METAL_HOME). Never shown to agents. */
  metalHome: string;
  /** Private RPC endpoint (METAL_RPC_URL). Passed to commands that read the chain. */
  rpcUrl: string;
  timeoutMs?: number;
  /**
   * Price the seller's 402 currently asks, in cents, or undefined if unknown. When given, a
   * price that differs from what control approved is refused before anything is signed.
   */
  quote?: (url: string) => Promise<number | undefined>;
  /** Look up a signed x402 payment whose answer was lost (facilitator /settlements by nonce). */
  lookupSettlement?: (url: string, nonce: string) => Promise<RailResult | undefined>;
}

interface Attempt {
  kind: "pay" | "pull";
  args: string[];
  url?: string;
  nonce?: string;
  last: RailResult;
}

const ADDRESS = /^0x[0-9a-fA-F]{40}$/;
const CRED_NAME = /^[A-Za-z0-9._-]+\.json$/;

/**
 * metal_x402 rail (ADR-010). routingRef decides the operation:
 *   https://... or http://127.0.0.1... -> `pay <url> --mandate` (x402 purchase)
 *   0x<address>                         -> `mandate pull --to --payment-id` (refund / payout)
 * `instruction.credentialRef` names the mandate credential file inside METAL_HOME.
 */
export class MetalAdapter implements RailAdapter {
  readonly rail = "metal_x402" as const;
  private readonly attempts = new Map<string, Attempt>();

  constructor(private readonly opts: MetalAdapterOptions) {}

  async execute(ins: RailInstruction): Promise<RailResult> {
    const prior = this.attempts.get(ins.idempotencyKey);
    if (prior) return this.getStatus(ins.idempotencyKey);
    if (ins.amount.currency !== "USDZ") return failed("metal_x402 pays USDZ only");
    const cred = this.credentialPath(ins.credentialRef);
    if (!cred) return failed("missing or invalid credentialRef");

    if (ADDRESS.test(ins.routingRef)) {
      const args = [
        "mandate",
        "pull",
        "--credential",
        cred,
        "--to",
        ins.routingRef,
        "--amount",
        centsToUsdz(ins.amount.cents),
        "--payment-id",
        ins.idempotencyKey,
        "--network",
        "testnet",
        "--rpc-url",
        this.opts.rpcUrl,
      ];
      return this.runPull(ins.idempotencyKey, args);
    }

    const url = parseSellerUrl(ins.routingRef);
    if (!url) return failed("routingRef is neither an address nor a seller URL");
    if (this.opts.quote) {
      const offered = await this.opts.quote(url);
      if (offered === undefined) return failed("seller price unknown; nothing signed");
      if (offered !== ins.amount.cents) {
        return failed(`price changed: offered ${offered}, approved ${ins.amount.cents}`);
      }
    }
    const args = ["pay", url, "--mandate", cred, "--network", "testnet"];
    const outcome = classifyPay(await this.opts.run(args, this.timeout()));
    const result = toResult(outcome, ins.amount.cents);
    this.attempts.set(ins.idempotencyKey, {
      kind: "pay",
      args,
      url,
      ...(outcome.kind !== "refused" && outcome.kind !== "held" && outcome.nonce
        ? { nonce: outcome.nonce }
        : {}),
      last: result,
    });
    return result;
  }

  async getStatus(idempotencyKey: string): Promise<RailResult> {
    const a = this.attempts.get(idempotencyKey);
    if (!a) return { status: "unknown", detail: "no attempt recorded in this process" };
    if (a.last.status === "succeeded" || a.last.status === "failed") return a.last;
    if (a.kind === "pull") return this.runPull(idempotencyKey, a.args); // same id pays at most once
    if (a.nonce && a.url && this.opts.lookupSettlement) {
      const found = await this.opts.lookupSettlement(a.url, a.nonce);
      if (found) {
        a.last = found;
        return found;
      }
    }
    return a.last;
  }

  private async runPull(key: string, args: string[]): Promise<RailResult> {
    const result = toResult(classifyPull(await this.opts.run(args, this.timeout())));
    this.attempts.set(key, { kind: "pull", args, last: result });
    return result;
  }

  private credentialPath(ref: string | undefined): string | undefined {
    if (!ref || !CRED_NAME.test(ref)) return undefined;
    return join(this.opts.metalHome, ref);
  }

  private timeout(): number {
    return this.opts.timeoutMs ?? 60_000;
  }
}

function parseSellerUrl(ref: string): string | undefined {
  try {
    const u = new URL(ref);
    const local = u.hostname === "127.0.0.1" || u.hostname === "localhost";
    if (u.protocol === "https:" || (u.protocol === "http:" && local)) return u.toString();
  } catch {
    // not a URL
  }
  return undefined;
}

function failed(detail: string): RailResult {
  return { status: "failed", detail };
}

function toResult(o: MetalOutcome, approvedCents?: number): RailResult {
  switch (o.kind) {
    case "paid": {
      const off =
        approvedCents !== undefined &&
        o.amountCents !== undefined &&
        o.amountCents !== approvedCents
          ? `; charged ${o.amountCents}, approved ${approvedCents}`
          : "";
      return { status: "succeeded", ...(o.tx ? { railRef: o.tx } : {}), detail: `paid${off}` };
    }
    case "refused":
      return { status: "failed", detail: `refused: ${o.reason}` };
    case "pending":
      return { status: "pending", detail: o.detail };
    case "held":
      return { status: "pending", detail: o.detail };
    case "unknown":
      return {
        status: "unknown",
        ...(o.nonce ? { railRef: `nonce:${o.nonce}` } : {}),
        detail: o.detail,
      };
  }
}
