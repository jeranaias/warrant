import { mkdtempSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { QUERY_PRICE } from "@warrant/control";
import { CATALOG, sampleInventory } from "./catalog.js";
import { OrderStore } from "./orders.js";
import { recordFromSettlement, sha256Of } from "./sale.js";
import type { SettledSale } from "./sale.js";
import { createStoreApp, routesFor } from "./server.js";

const PAY_TO = "0x" + "b".repeat(40);
const PAYER = "0x" + "c".repeat(40);
const TX = "0x" + "d".repeat(64);
const first = CATALOG[0];
if (!first) throw new Error("empty catalog");
const item = first;

const sale = (
  over: Partial<SettledSale["result"]> = {},
  body: unknown = '{"rows":[]}',
): SettledSale => ({
  result: {
    success: true,
    transaction: TX,
    payer: PAYER,
    network: "eip155:63825",
    extra: { settlement: { id: "set_1", first: true } },
    ...over,
  },
  transportContext: { responseBody: body },
});
const deps = { signedOffer: () => "signed-offer-jwt", item, priceCents: 5, payTo: PAY_TO };

describe("routes", () => {
  it("every item is its own route at the query price, requiring a signed order", () => {
    const routes = routesFor(PAY_TO) as Record<string, { accepts: Record<string, unknown> }>;
    expect(Object.keys(routes)).toEqual(CATALOG.map((c) => c.resource));
    for (const it of CATALOG) {
      const a = routes[it.resource]?.accepts;
      expect(a?.["price"]).toBe("0.05");
      expect(a?.["network"]).toBe("eip155:63825");
      expect(a?.["extra"]).toEqual({ signedOffer: "required", resource: it.resource });
    }
    expect(QUERY_PRICE.cents).toBe(5);
  });
});

describe("recordFromSettlement", () => {
  it("stores the signed order with tx hash, payer and a hash of what we delivered", () => {
    const r = recordFromSettlement(sale(), { ...deps, batchId: "b1" });
    expect(r).toMatchObject({
      resource: item.resource,
      price: { currency: "USDZ", cents: 5 },
      payer: PAYER,
      payee: PAY_TO,
      txHash: TX,
      settlementId: "set_1",
      signedOffer: "signed-offer-jwt",
      deliveredSha256: sha256Of('{"rows":[]}'),
      upstreamBatchId: "b1",
    });
  });

  it("records nothing for a failed or repeated settlement", () => {
    expect(recordFromSettlement(sale({ success: false }), deps)).toBeNull();
    expect(
      recordFromSettlement(sale({ extra: { settlement: { id: "set_1", first: false } } }), deps),
    ).toBeNull();
  });

  it("refuses a settled sale with no signed order (the route check was bypassed)", () => {
    expect(() => recordFromSettlement(sale(), { ...deps, signedOffer: () => "" })).toThrow(
      /without a signed order/,
    );
  });
});

describe("OrderStore", () => {
  const rec = () => {
    const r = recordFromSettlement(sale(), deps);
    if (!r) throw new Error("no record");
    return r;
  };

  it("is append-only: the same tx can't be stored twice", () => {
    const s = new OrderStore();
    const r = s.add(rec());
    expect(s.get(r.orderId)).toEqual(r);
    expect(s.byPayer(PAYER.toUpperCase().replace("0X", "0x"))).toHaveLength(1);
    expect(() => s.add({ ...rec() })).toThrow(/transaction already stored/);
  });

  it("survives a restart from its file", () => {
    const file = join(mkdtempSync(join(tmpdir(), "orders-")), "orders.jsonl");
    const r = new OrderStore(file).add(rec());
    const again = new OrderStore(file);
    expect(again.byTransaction(TX)?.orderId).toBe(r.orderId);
  });
});

describe("store app (mock mode)", () => {
  it("serves an item with its batch id, and lists orders without the signed offer", async () => {
    const orders = new OrderStore();
    const r = recordFromSettlement(sale(), deps);
    if (r) orders.add(r);
    const app = createStoreApp({ payTo: PAY_TO, inventory: sampleInventory(), orders });
    const server = app.listen(0, "127.0.0.1");
    await new Promise<void>((ok) => server.once("listening", () => ok()));
    try {
      const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
      const q = (await (await fetch(`${base}${item.path}`)).json()) as { batchId: string };
      expect(q.batchId).toBe(`sample-${item.id}`);
      const list = (await (await fetch(`${base}/orders`)).json()) as Record<string, unknown>[];
      expect(list).toHaveLength(1);
      expect(list[0]).not.toHaveProperty("signedOffer");
      expect((await fetch(`${base}/orders/nope`)).status).toBe(404);
    } finally {
      server.close();
    }
  });
});
