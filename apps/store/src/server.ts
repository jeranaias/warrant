import express from "express";
import type { Express } from "express";
import type { RoutesConfig, x402ResourceServer } from "@x402/core/server";
import type { Network } from "@x402/core/types";
import { paymentMiddleware } from "@x402/express";
import { SIGNED_OFFER_REQUIRED, signedOfferOf } from "@metalntwx/metal-pay/mandates";
import { PASS_HEADER, QUERY_PRICE } from "@warrant/control";
import { CATALOG } from "./catalog.js";
import type { CatalogItem, Inventory } from "./catalog.js";
import type { OrderStore } from "./orders.js";
import { recordFromSettlement, responseBodyOf } from "./sale.js";

export const METAL_TESTNET: Network = "eip155:63825";
/** SignedOrderRecord.buyerPass's limit; a longer header is not kept (and never passes a check). */
const MAX_PASS_CHARS = 20_000;

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
  /**
   * Warrant pass checks (ADR-012), usually a `PassChecker` from @warrant/control. When given, an
   * item is served only to a buyer whose `x-warrant-pass` passes; a refusal answers 403, which
   * cancels the x402 payment. Omit to serve without checking.
   */
  passes?: StorePassChecks;
  /** Our public origin as buyers see it (e.g. a tunnel); passes name this URL. Default: the Host. */
  publicOrigin?: string;
}

export interface StorePassChecks {
  /** Before serving: the buyer's header, the URL it paid for and our price. */
  check(header: string | undefined, url: string, priceCents: number): PassVerdict;
  /** After settlement, with the account that paid. Returns a problem to record, if any. */
  settled(header: string | undefined, payer: string): string | undefined;
}

export interface PassVerdict {
  ok: boolean;
  problems: string[];
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
        if (!record) return;
        const buyerPass = passHeaderOf(ctx.transportContext);
        const problem = opts.passes?.settled(buyerPass, record.payer);
        if (problem) opts.onError?.(`order from ${record.payer}: ${problem}`);
        const keep = buyerPass !== undefined && buyerPass.length <= MAX_PASS_CHARS;
        opts.orders.add(keep ? { ...record, buyerPass } : record);
      } catch (e) {
        // Never throw out of the hook: the buyer has paid. Surface it for the operator instead.
        opts.onError?.(`could not store order: ${(e as Error).message}`);
      }
    });
    app.use(paymentMiddleware(routesFor(opts.payTo), server));
  }

  for (const it of CATALOG) {
    app.get(it.path, (req, res) => {
      if (opts.passes) {
        const origin = opts.publicOrigin ?? `${req.protocol}://${req.get("host") ?? ""}`;
        const r = opts.passes.check(
          req.get(PASS_HEADER),
          `${origin}${req.path}`,
          QUERY_PRICE.cents,
        );
        // 403 cancels the payment: a buyer whose owner did not authorize this is never charged.
        if (!r.ok) {
          return void res.status(403).json({ error: "warrant pass refused", problems: r.problems });
        }
      }
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

/** The buyer's pass from x402's transport context (the paid request's headers). */
function passHeaderOf(transportContext: unknown): string | undefined {
  const adapter = (transportContext as { request?: { adapter?: { getHeader?: unknown } } } | null)
    ?.request?.adapter;
  const get = adapter?.getHeader;
  if (!adapter || typeof get !== "function") return undefined;
  const v: unknown = (get as (name: string) => unknown).call(adapter, PASS_HEADER);
  return typeof v === "string" && v ? v : undefined;
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
