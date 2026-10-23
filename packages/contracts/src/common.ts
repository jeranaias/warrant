import { z } from "zod";

/** Opaque string ids. Prefixes are a convention (wrt_, prop_, led_, ...), not enforced. */
export const Id = z.string().min(1).max(128);
export type Id = z.infer<typeof Id>;

/** ISO-8601 UTC timestamp. */
export const Timestamp = z.iso.datetime();
export type Timestamp = z.infer<typeof Timestamp>;

/** ISO-4217 currency, or USDZ for the Metal stablecoin. */
export const Currency = z.enum(["USD", "EUR", "GBP", "AUD", "SGD", "HKD", "USDZ"]);
export type Currency = z.infer<typeof Currency>;

/**
 * Internal money is ALWAYS integer cents (minor units) in one currency.
 * Conversion happens only at the rail boundary:
 *   - Metal / USDZ: 18-decimal base units (bigint); 1 cent = 10^16 base units
 *   - Airwallex:    major units (decimal), e.g. 12.34
 * Never do money arithmetic on floats.
 */
export const Money = z
  .object({
    currency: Currency,
    cents: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
  })
  .strict();
export type Money = z.infer<typeof Money>;

export const AgentRole = z.enum(["sourcing", "support", "treasury"]);
export type AgentRole = z.infer<typeof AgentRole>;

/** Payment rails. Every outbound payment names exactly one. */
export const Rail = z.enum([
  "metal_x402", // x402 pay-per-call on Metal (USDZ)
  "airwallex_transfer", // Airwallex payout to a beneficiary
  "airwallex_fx", // Airwallex conversion between wallet balances
  "airwallex_card", // spend on an Airwallex-issued virtual card
]);
export type Rail = z.infer<typeof Rail>;
