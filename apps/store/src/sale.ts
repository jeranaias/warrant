import { createHash, randomUUID } from "node:crypto";
import type { SignedOrderRecord } from "@warrant/contracts";
import type { CatalogItem } from "./catalog.js";

/**
 * The parts of x402's SettleResultContext we read. Kept structural so tests don't need a
 * facilitator and so a field the SDK adds can't change what we store.
 */
export interface SettledSale {
  result: {
    success: boolean;
    transaction: string;
    payer?: string;
    network: string;
    extra?: Readonly<Record<string, unknown>>;
  };
  /** HTTPTransportContext from @x402/core/http; `responseBody` is what our handler answered. */
  transportContext?: unknown;
}

export interface SaleDeps {
  /** signedOfferOf(paymentPayload) from @metalntwx/metal-pay/mandates, bound to this sale. */
  signedOffer: () => string;
  item: CatalogItem;
  priceCents: number;
  payTo: string;
  /** The upstream batch the delivered data came from. */
  batchId?: string;
  now?: () => Date;
}

export function sha256Of(body: unknown): string {
  const h = createHash("sha256");
  if (typeof body === "string") h.update(body, "utf8");
  else if (body instanceof Uint8Array) h.update(body);
  else h.update(JSON.stringify(body ?? null), "utf8");
  return h.digest("hex");
}

export function responseBodyOf(transportContext: unknown): unknown {
  if (
    transportContext &&
    typeof transportContext === "object" &&
    "responseBody" in transportContext
  ) {
    return (transportContext as { responseBody: unknown }).responseBody;
  }
  return undefined;
}

/**
 * Builds the record to store for a settled sale, or null when there is nothing to store: a failed
 * settlement, or a settlement that is not the first for this payment (the docs' `settlement.first`).
 * Throws if a successful settlement carries no signed order: the route requires one, so that would
 * mean the check was bypassed.
 */
export function recordFromSettlement(sale: SettledSale, deps: SaleDeps): SignedOrderRecord | null {
  const { result } = sale;
  if (!result.success) return null;
  const settlement = result.extra?.["settlement"] as { id?: string; first?: boolean } | undefined;
  if (settlement && settlement.first === false) return null;
  const signedOffer = deps.signedOffer();
  if (!signedOffer) throw new Error("settled sale without a signed order");
  if (!result.payer) throw new Error("settled sale without a payer");
  return {
    orderId: `ord_${randomUUID()}`,
    resource: deps.item.resource,
    price: { currency: "USDZ", cents: deps.priceCents },
    payee: deps.payTo,
    payer: result.payer,
    network: "eip155:63825",
    txHash: result.transaction,
    settlementId: settlement?.id ?? result.transaction,
    signedOffer,
    deliveredSha256: sha256Of(responseBodyOf(sale.transportContext)),
    ...(deps.batchId ? { upstreamBatchId: deps.batchId } : {}),
    at: (deps.now ?? (() => new Date()))().toISOString(),
  };
}
