import { baseUnitsToCents } from "./units.js";

/**
 * What an x402 seller asks right now, read from its unpaid answer: `402` with a base64 JSON
 * `PAYMENT-REQUIRED` header listing what it accepts (x402 v2). Nothing is signed or paid. Used as
 * `MetalAdapterOptions.quote`, so a price that changed after control approved it is refused
 * before the CLI signs anything.
 */

const METAL_TESTNET = "eip155:63825";

export type FetchLike = (url: string, init?: { method?: string }) => Promise<Response>;

export function x402Quote(
  fetchFn: FetchLike = fetch,
): (url: string) => Promise<number | undefined> {
  return async (url) => {
    try {
      const res = await fetchFn(url, { method: "GET" });
      if (res.status !== 402) return undefined;
      return quoteCents(res.headers.get("payment-required"));
    } catch {
      return undefined; // unknown price: the adapter signs nothing
    }
  };
}

/** The testnet `exact` offer's amount (USDZ base units) in cents, or undefined. */
export function quoteCents(header: string | null | undefined): number | undefined {
  if (!header) return undefined;
  try {
    const body = JSON.parse(Buffer.from(header, "base64").toString("utf8")) as {
      accepts?: { scheme?: string; network?: string; amount?: string }[];
    };
    const offer = body.accepts?.find((a) => a.scheme === "exact" && a.network === METAL_TESTNET);
    if (!offer?.amount || !/^\d+$/.test(offer.amount)) return undefined;
    return baseUnitsToCents(BigInt(offer.amount));
  } catch {
    return undefined;
  }
}
