import { createServer } from "node:http";
import type { Server } from "node:http";
import type { MetalFault, MockMetalChain, Upstream } from "./index.js";

/**
 * The mock chain over HTTP, for `pnpm mocks` and tests that read a real 402 (x402Quote).
 *
 *   GET  <seller path>              402 with a base64 `PAYMENT-REQUIRED` header (x402 v2, exact, testnet)
 *   GET  /settlements?nonce=<hex>   the settled payment, or 404 (the facilitator lookup)
 *   POST /_mock/price {"cents":4}   the upstream's price (2 cents to start; 4 is over sourcing's cap)
 *   POST /_mock/fault <MetalFault>  the next pay/pull misbehaves (see MetalFault)
 *   GET  /_mock/state               transactions, refusals and mandates
 */

const NETWORK = "eip155:63825";
const BASE_UNITS_PER_CENT = 10n ** 16n; // 1 USDZ = 10^18 base units

export interface MetalMock {
  url: string;
  server: Server;
  close(): Promise<void>;
}

export async function startMetalMock(opts: {
  chain: MockMetalChain;
  upstream: Upstream;
  port?: number;
}): Promise<MetalMock> {
  const { chain, upstream } = opts;
  const upstreamPath = new URL(upstream.url).pathname;

  const server = createServer(async (req, res) => {
    const chunks: Buffer[] = [];
    for await (const c of req) chunks.push(c as Buffer);
    const url = new URL(req.url ?? "/", "http://mock");
    const json = (status: number, body: unknown, headers: Record<string, string> = {}) =>
      res
        .writeHead(status, { "content-type": "application/json", ...headers })
        .end(JSON.stringify(body));
    const body = (): Record<string, unknown> => {
      try {
        return JSON.parse(Buffer.concat(chunks).toString() || "{}") as Record<string, unknown>;
      } catch {
        return {};
      }
    };

    if (req.method === "GET" && url.pathname === upstreamPath) {
      const required = {
        x402Version: 2,
        accepts: [
          {
            scheme: "exact",
            network: NETWORK,
            amount: (BigInt(upstream.price()) * BASE_UNITS_PER_CENT).toString(),
            payTo: upstream.payTo,
          },
        ],
      };
      const header = Buffer.from(JSON.stringify(required)).toString("base64");
      return json(402, { error: "payment required" }, { "payment-required": header });
    }
    if (req.method === "GET" && url.pathname === "/settlements") {
      const tx = chain.settlementByNonce(url.searchParams.get("nonce") ?? "");
      return tx ? json(200, tx) : json(404, { error: "no settlement for that nonce" });
    }
    if (req.method === "POST" && url.pathname === "/_mock/price") {
      try {
        upstream.setPrice(Number(body()["cents"]));
        return json(200, { cents: upstream.price() });
      } catch (e) {
        return json(400, { error: (e as Error).message });
      }
    }
    if (req.method === "POST" && url.pathname === "/_mock/fault") {
      const f = body() as unknown as MetalFault;
      if (typeof f.kind !== "string") return json(400, { error: "a fault needs a kind" });
      chain.fault(f);
      return json(200, { queued: f });
    }
    if (req.method === "GET" && url.pathname === "/_mock/state") {
      return json(200, {
        txs: chain.txs,
        refusals: chain.refusals,
        mandates: chain.mandateList(),
      });
    }
    json(404, { error: "not found" });
  });

  await new Promise<void>((resolve) => server.listen(opts.port ?? 0, "127.0.0.1", resolve));
  const addr = server.address() as { port: number };
  return {
    url: `http://127.0.0.1:${addr.port}`,
    server,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}
