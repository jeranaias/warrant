import { describe, expect, it } from "vitest";
import { MetalAdapter } from "./adapter.js";
import type { CliResult, CliRunner } from "./cli.js";
import {
  AUTHORIZATION_STATE_SELECTOR,
  AUTHORIZATION_USED_TOPIC,
  chainSettlementLookup,
  lookupNonce,
} from "./lookup.js";
import type { JsonRpc, PayerOf } from "./lookup.js";

// Shapes as the Metal testnet node answered them (2026-11-02): USDZ is the token at 0x…b5d5, and
// the authorizer of a pay under a mandate is the credential's principal.
const PAYER: PayerOf = {
  principal: "0x50b476f235DD6021bb32684EF6f0461BA8e00689",
  token: "0x000000000000000000000000000000000000B5d5",
};
const NONCE = "0x627a1f225a62" + "0".repeat(52);
const TX = "0x" + "9c".repeat(32);
const TRUE = "0x" + "0".repeat(63) + "1";
const FALSE = "0x" + "0".repeat(64);

interface Call {
  method: string;
  params: unknown[];
}

/** A node that answers from a script: eth_call, eth_blockNumber, and eth_getLogs by call order. */
function node(o: { used: string; head?: number; logs?: (unknown[] | Error)[] }) {
  const calls: Call[] = [];
  const logs = [...(o.logs ?? [])];
  const rpc: JsonRpc = (method, params) => {
    calls.push({ method, params });
    if (method === "eth_call") return Promise.resolve(o.used);
    if (method === "eth_blockNumber") return Promise.resolve("0x" + (o.head ?? 100).toString(16));
    if (method === "eth_getLogs") {
      const next = logs.shift() ?? [];
      return next instanceof Error ? Promise.reject(next) : Promise.resolve(next);
    }
    return Promise.reject(new Error(`unexpected ${method}`));
  };
  return { rpc, calls };
}

describe("lookupNonce (ERC-3009 nonce on chain)", () => {
  it("asks the token whether the principal's nonce was used, encoded as the ABI says", async () => {
    const n = node({ used: FALSE });
    await lookupNonce(n.rpc, PAYER, NONCE);
    const call = n.calls[0];
    expect(call?.method).toBe("eth_call");
    const [tx, block] = call?.params as [{ to: string; data: string }, string];
    expect(tx.to).toBe(PAYER.token);
    expect(tx.data).toBe(
      AUTHORIZATION_STATE_SELECTOR +
        "0".repeat(24) +
        "50b476f235dd6021bb32684ef6f0461ba8e00689" +
        NONCE.slice(2),
    );
    expect(block).toBe("latest");
  });

  it("an unused nonce stays in doubt: no answer, no log search", async () => {
    const n = node({ used: FALSE });
    expect(await lookupNonce(n.rpc, PAYER, NONCE)).toBeUndefined();
    expect(n.calls.map((c) => c.method)).toEqual(["eth_call"]);
  });

  it("a used nonce is paid, with the settling transaction from AuthorizationUsed", async () => {
    const n = node({ used: TRUE, logs: [[{ transactionHash: TX }]] });
    expect(await lookupNonce(n.rpc, PAYER, NONCE)).toEqual({
      status: "succeeded",
      railRef: TX,
      detail: "paid (found on chain by its nonce)",
    });
    const filter = (n.calls[2]?.params as [{ topics: string[]; address: string }])[0];
    expect(filter.address).toBe(PAYER.token);
    expect(filter.topics).toEqual([
      AUTHORIZATION_USED_TOPIC,
      "0x" + "0".repeat(24) + "50b476f235dd6021bb32684ef6f0461ba8e00689",
      NONCE,
    ]);
  });

  it("halves the block range when the node refuses it", async () => {
    const n = node({
      used: TRUE,
      head: 1000,
      logs: [new Error("range too large"), [], [{ transactionHash: TX }]],
    });
    expect((await lookupNonce(n.rpc, PAYER, NONCE))?.railRef).toBe(TX);
    const ranges = n.calls
      .filter((c) => c.method === "eth_getLogs")
      .map((c) => {
        const f = (c.params as [{ fromBlock: string; toBlock: string }])[0];
        return [Number(f.fromBlock), Number(f.toBlock)];
      });
    expect(ranges).toEqual([
      [0, 1000],
      [501, 1000],
      [1, 500],
    ]);
  });

  it("a used nonce whose transaction is out of reach is still paid, by the nonce", async () => {
    const n = node({ used: TRUE, logs: [[]] });
    expect(await lookupNonce(n.rpc, PAYER, NONCE)).toEqual({
      status: "succeeded",
      railRef: `nonce:${NONCE}`,
      detail: "paid (nonce used on chain)",
    });
  });

  it("a nonce or address that isn't hex is not looked up", async () => {
    const n = node({ used: TRUE });
    expect(await lookupNonce(n.rpc, PAYER, "0x77")).toBeUndefined();
    expect(await lookupNonce(n.rpc, { ...PAYER, token: "usdz" }, NONCE)).toBeUndefined();
    expect(n.calls).toHaveLength(0);
  });
});

describe("chainSettlementLookup", () => {
  it("without the credential, or when anything fails, the payment stays in doubt", async () => {
    const failing: JsonRpc = () => Promise.reject(new Error("node down"));
    const lookup = chainSettlementLookup(failing);
    expect(await lookup("http://127.0.0.1:4022/data", NONCE)).toBeUndefined();
    expect(await lookup("http://127.0.0.1:4022/data", NONCE, "/no/such/cred.json")).toBeUndefined();
  });
});

describe("MetalAdapter hands the lookup the credential the pay was signed under", () => {
  const res = (o: Partial<CliResult>): CliResult => ({
    code: 0,
    stdout: "",
    stderr: "",
    timedOut: false,
    ...o,
  });

  it("passes the METAL_HOME credential path with the url and nonce", async () => {
    const seen: (string | undefined)[][] = [];
    const run: CliRunner = () =>
      Promise.resolve(
        res({ code: 1, stdout: `nonce ${NONCE}\n`, stderr: "error: payment in doubt" }),
      );
    const a = new MetalAdapter({
      run,
      metalHome: "/m",
      rpcUrl: "https://rpc",
      lookupSettlement: (url, nonce, credentialPath) => {
        seen.push([url, nonce, credentialPath]);
        return Promise.resolve({ status: "succeeded", railRef: TX });
      },
    });
    const first = await a.execute({
      rail: "metal_x402",
      reservationId: "res_1",
      idempotencyKey: "idem-00000001",
      amount: { currency: "USDZ", cents: 2 },
      routingRef: "http://127.0.0.1:4022/data",
      credentialRef: "sourcing.json",
    });
    expect(first.status).toBe("unknown");
    expect(await a.getStatus("idem-00000001")).toEqual({ status: "succeeded", railRef: TX });
    expect(seen).toHaveLength(1);
    expect(seen[0]?.[0]).toBe("http://127.0.0.1:4022/data");
    expect(seen[0]?.[1]).toBe(NONCE);
    expect(seen[0]?.[2]?.replace(/\\/g, "/")).toBe("/m/sourcing.json");
  });
});
