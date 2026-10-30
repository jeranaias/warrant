import express from "express";
import type { Express } from "express";
import type { RoutesConfig, x402ResourceServer } from "@x402/core/server";
import type { Network } from "@x402/core/types";
import { paymentMiddleware } from "@x402/express";
import { SIGNED_OFFER_REQUIRED, signedOfferOf } from "@metalntwx/metal-pay/mandates";
import { QUERY_PRICE } from "@warrant/control";
import { CATALOG } from "./catalog.js";
import type { CatalogItem, Inventory } from "./catalog.js";
import type { OrderStore } from "./orders.js";
import { recordFromSettlement, responseBodyOf } from "./sale.js";

export const METAL_TESTNET: Network = "eip155:63825";

export interface StoreOptions {
  /** Our Metal address (payTo). */
  payTo: string;
  inventory: Inventory;
  orders: OrderStore;
  /**
   * x402 resource server with Metal's scheme and `requireSignedOffer` applied (see main.ts).
   * Omit for mock mode: routes answer unpaid and nothing is recorded.
   */
  x402?: x402ResourceServer;
  onError?: (msg: string) => void;
}

/** x402 route table: one route per item, each requiring the buyer's signed order. */
export function routesFor(payTo: string, items: readonly CatalogItem[] = CATALOG): RoutesConfig {
  return Object.fromEntries(
    items.map((it) => [
      it.resource,
      {
        accepts: {
          scheme: "exact",
          network: METAL_TESTNET,
          payTo,
          price: dollars(QUERY_PRICE.cents),
          extra: { ...SIGNED_OFFER_REQUIRED, resource: it.resource },
        },
        description: it.title,
      },
    ]),
  );
}

export function createStoreApp(opts: StoreOptions): Express {
  const app = express();
  app.disable("x-powered-by");
  const byResource = new Map(CATALOG.map((it) => [it.resource as string, it]));

  if (opts.x402) {
    const server = opts.x402;
    server.onAfterSettle(async (ctx) => {
      try {
        const resource = ctx.requirements.extra?.["resource"];
        const item = typeof resource === "string" ? byResource.get(resource) : undefined;
        if (!item) return;
        const body = responseBodyOf(ctx.transportContext);
        const record = recordFromSettlement(ctx, {
          signedOffer: () => signedOfferOf(ctx.paymentPayload),
          item,
          priceCents: QUERY_PRICE.cents,
          payTo: opts.payTo,
          ...batchOf(body),
        });
        if (record) opts.orders.add(record);
      } catch (e) {
        // Never throw out of the hook: the buyer has paid. Surface it for the operator instead.
        opts.onError?.(`could not store order: ${(e as Error).message}`);
      }
    });
    app.use(paymentMiddleware(routesFor(opts.payTo), server));
  }

  for (const it of CATALOG) {
    app.get(it.path, (_req, res) => {
      const batch = opts.inventory.current(it.id);
      // 503 cancels the payment (handler >= 400), so the buyer is never charged for nothing.
      if (!batch) return void res.status(503).json({ error: "no data yet" });
      res.json({ item: it.id, batchId: batch.batchId, rows: batch.rows });
    });
  }

  // Internal, for control's dispute flow and the dashboard. Bind the server to 127.0.0.1.
  app.get("/orders", (_req, res) => {
    // The list omits the signed offers; fetch one order to see its proof.
    res.json(
      opts.orders.list().map((o) => ({
        orderId: o.orderId,
        resource: o.resource,
        price: o.price,
        payer: o.payer,
        txHash: o.txHash,
        upstreamBatchId: o.upstreamBatchId,
        at: o.at,
      })),
    );
  });
  app.get("/orders/:id", (req, res) => {
    const o = opts.orders.get(req.params.id);
    if (!o) return void res.status(404).json({ error: "not found" });
    res.json(o);
  });
  app.get("/healthz", (_req, res) => res.json({ ok: true, paid: Boolean(opts.x402) }));
  return app;
}

/** 5 -> "0.05": x402's price is a dollar amount. Integer math only. */
export function dollars(cents: number): string {
  if (!Number.isSafeInteger(cents) || cents < 0) throw new Error("cents must be a whole number");
  return `${Math.floor(cents / 100)}.${String(cents % 100).padStart(2, "0")}`;
}

function batchOf(body: unknown): { batchId?: string } {
  try {
    const text =
      typeof body === "string"
        ? body
        : body instanceof Uint8Array
          ? Buffer.from(body).toString("utf8")
          : JSON.stringify(body);
    const id = (JSON.parse(text) as { batchId?: unknown }).batchId;
    return typeof id === "string" ? { batchId: id } : {};
  } catch {
    return {};
  }
}
