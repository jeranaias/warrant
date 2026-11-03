import { readFile } from "node:fs/promises";
import { extractTerms, parseCredential } from "@metalntwx/metal-pay/mandates";
import type { RailResult } from "../types.js";

/**
 * Settles an x402 pay whose answer was lost, from the chain (ADR-019). The nonce `metal-agent pay`
 * printed is the ERC-3009 authorization nonce the mandate's principal signed; the token records it
 * once used (`authorizationState`) and emits `AuthorizationUsed(authorizer, nonce)` in the
 * settling transaction. The chain is the authority: no facilitator account or seller token needed.
 *
 * Only "used" is an answer. An unused nonce may still be settled later, so it stays in doubt
 * (undefined), never "failed".
 */

/** `authorizationState(address,bytes32)` (ERC-3009). */
export const AUTHORIZATION_STATE_SELECTOR = "0xe94a0102";
/** `AuthorizationUsed(address indexed authorizer, bytes32 indexed nonce)` (ERC-3009). */
export const AUTHORIZATION_USED_TOPIC =
  "0x98de503528ee59b575ef0c0a2576a82497bfc029a5685b209e9ec333479b10a5";

const HEX32 = /^0x[0-9a-fA-F]{64}$/;
const ADDRESS = /^0x[0-9a-fA-F]{40}$/;
/**
 * Blocks searched back for the settling transaction once the nonce is known to be used: about 40
 * minutes of Metal testnet (~20 blocks a second). Older settlements are still reported paid, by nonce.
 */
const LOOKBACK_BLOCKS = 50_000n;

/** One JSON-RPC call. Injected so tests run on recorded answers. */
export type JsonRpc = (method: string, params: unknown[]) => Promise<unknown>;

/** JSON-RPC over HTTP POST to `rpcUrl`. The URL is never put in an error or a result. */
export function httpJsonRpc(rpcUrl: string, timeoutMs = 15_000): JsonRpc {
  let id = 0;
  return async (method, params) => {
    const res = await fetch(rpcUrl, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: ++id, method, params }),
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!res.ok) throw new Error(`rpc ${method} answered ${res.status}`);
    const body = (await res.json()) as { result?: unknown; error?: { message?: string } };
    if (body.error) throw new Error(`rpc ${method}: ${body.error.message ?? "error"}`);
    return body.result;
  };
}

/** Who signed and in which token, from the mandate credential. */
export interface PayerOf {
  principal: string;
  token: string;
}

/** The principal and token a mandate credential file names. */
export async function payerOfCredential(path: string): Promise<PayerOf> {
  const terms = extractTerms(parseCredential(JSON.parse(await readFile(path, "utf8"))));
  return { principal: terms.principal, token: terms.constraints.token };
}

const word = (address: string) => "0x" + address.slice(2).toLowerCase().padStart(64, "0");

/**
 * Looks one nonce up. Returns `succeeded` (with the settling tx when it is found in the recent
 * blocks), or undefined while the nonce is unused or the input can't be checked.
 */
export async function lookupNonce(
  rpc: JsonRpc,
  payer: PayerOf,
  nonce: string,
): Promise<RailResult | undefined> {
  if (!HEX32.test(nonce) || !ADDRESS.test(payer.principal) || !ADDRESS.test(payer.token)) {
    return undefined;
  }
  const n = nonce.toLowerCase();
  const used = await rpc("eth_call", [
    {
      to: payer.token,
      data: AUTHORIZATION_STATE_SELECTOR + word(payer.principal).slice(2) + n.slice(2),
    },
    "latest",
  ]);
  if (typeof used !== "string" || BigInt(used === "0x" ? 0 : used) === 0n) return undefined;

  const tx = await settlingTx(rpc, payer, n).catch(() => undefined);
  return {
    status: "succeeded",
    railRef: tx ?? `nonce:${n}`,
    detail: tx ? "paid (found on chain by its nonce)" : "paid (nonce used on chain)",
  };
}

/** The transaction that used the nonce, searched in the last LOOKBACK_BLOCKS blocks. */
async function settlingTx(
  rpc: JsonRpc,
  payer: PayerOf,
  nonce: string,
): Promise<string | undefined> {
  const head = BigInt(String(await rpc("eth_blockNumber", [])));
  const floor = head > LOOKBACK_BLOCKS ? head - LOOKBACK_BLOCKS : 0n;
  // A node caps the range one request may span: halve it on refusal, newest blocks first.
  let span = head - floor + 1n;
  for (let end = head; end >= floor;) {
    const start = end - span + 1n > floor ? end - span + 1n : floor;
    let logs: unknown;
    try {
      logs = await rpc("eth_getLogs", [
        {
          address: payer.token,
          fromBlock: "0x" + start.toString(16),
          toBlock: "0x" + end.toString(16),
          topics: [AUTHORIZATION_USED_TOPIC, word(payer.principal), nonce],
        },
      ]);
    } catch (e) {
      if (span <= 1n) throw e;
      span = span / 2n;
      continue;
    }
    const hit = Array.isArray(logs)
      ? (logs as { transactionHash?: unknown }[]).find((l) => typeof l.transactionHash === "string")
      : undefined;
    if (hit) return hit.transactionHash as string;
    if (start === floor) break;
    end = start - 1n;
  }
  return undefined;
}

/**
 * The adapter's `lookupSettlement` for the live world: reads the credential the pay was signed
 * under, then asks the chain. Never throws: a failed read leaves the payment in doubt.
 */
export function chainSettlementLookup(rpc: JsonRpc) {
  return async (
    _url: string,
    nonce: string,
    credentialPath?: string,
  ): Promise<RailResult | undefined> => {
    if (!credentialPath) return undefined;
    try {
      return await lookupNonce(rpc, await payerOfCredential(credentialPath), nonce);
    } catch {
      return undefined;
    }
  };
}
