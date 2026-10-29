/**
 * What we sell. One route per item, so a signed order names exactly what was bought (the signed
 * order covers the route's `resource`, not query parameters).
 */
export interface CatalogItem {
  id: string;
  /** The x402 route key and the signed order's `resource`. */
  resource: `GET /query/${string}`;
  path: `/query/${string}`;
  title: string;
}

const item = (id: string, title: string): CatalogItem => ({
  id,
  resource: `GET /query/${id}`,
  path: `/query/${id}`,
  title,
});

export const CATALOG: readonly CatalogItem[] = [
  item("fx-eurusd", "EUR/USD spot, last 10 ticks"),
  item("btc-usd", "BTC/USD spot, last 10 ticks"),
  item("gold-usd", "Gold/USD spot, last 10 ticks"),
];

/** A batch of data bought from the upstream provider, resold per query. */
export interface UpstreamBatch {
  batchId: string;
  itemId: string;
  rows: readonly { t: string; price: string }[];
  /** Set when we learn the batch was bad. Disputes over orders served from it get refunds. */
  knownBad?: boolean;
}

/**
 * Latest batch per item. Sourcing (lane A/C) refreshes these from the upstream provider; until
 * then a fixed sample keeps the store runnable in mock mode.
 */
export class Inventory {
  private readonly latest = new Map<string, UpstreamBatch>();
  private readonly all = new Map<string, UpstreamBatch>();

  put(batch: UpstreamBatch): void {
    this.latest.set(batch.itemId, batch);
    this.all.set(batch.batchId, batch);
  }

  current(itemId: string): UpstreamBatch | undefined {
    return this.latest.get(itemId);
  }

  batch(batchId: string): UpstreamBatch | undefined {
    return this.all.get(batchId);
  }

  markBad(batchId: string): void {
    const b = this.all.get(batchId);
    if (b) b.knownBad = true;
  }
}

export function sampleInventory(): Inventory {
  const inv = new Inventory();
  for (const it of CATALOG) {
    inv.put({
      batchId: `sample-${it.id}`,
      itemId: it.id,
      rows: [{ t: "2026-10-29T00:00:00Z", price: "0" }],
    });
  }
  return inv;
}
