/**
 * USDZ unit conversion. The ONLY place cents meet USDZ base units (CLAUDE.md money rules).
 * 1 USDZ = 10^18 base units; 1 cent = 10^16 base units. Mandates pay whole cents only.
 */

export const BASE_UNITS_PER_CENT = 10n ** 16n;

export function centsToBaseUnits(cents: number): bigint {
  if (!Number.isSafeInteger(cents) || cents < 0) throw new Error("cents must be a whole number");
  return BigInt(cents) * BASE_UNITS_PER_CENT;
}

/** Throws unless the amount is a whole number of cents. */
export function baseUnitsToCents(base: bigint): number {
  if (base < 0n || base % BASE_UNITS_PER_CENT !== 0n) {
    throw new Error("amount is not a whole number of cents");
  }
  const cents = base / BASE_UNITS_PER_CENT;
  if (cents > BigInt(Number.MAX_SAFE_INTEGER)) throw new Error("amount too large");
  return Number(cents);
}

/** 3 -> "0.03", 1000 -> "10.00": the decimal the CLI's --cap / --budget / --amount flags take. */
export function centsToUsdz(cents: number): string {
  if (!Number.isSafeInteger(cents) || cents < 0) throw new Error("cents must be a whole number");
  const s = String(cents).padStart(3, "0");
  return `${s.slice(0, -2)}.${s.slice(-2)}`;
}

/**
 * Parses a decimal USDZ amount as printed by metal-agent ("0.01", "6.5", "10") into cents,
 * by string arithmetic. Throws on anything finer than a cent.
 */
export function usdzToCents(text: string): number {
  const m = /^(\d+)(?:\.(\d+))?$/.exec(text.trim());
  if (!m) throw new Error(`not a USDZ amount: ${text}`);
  const whole = m[1] ?? "0";
  const frac = (m[2] ?? "").replace(/0+$/, "");
  if (frac.length > 2) throw new Error(`finer than a cent: ${text}`);
  const cents = BigInt(whole) * 100n + BigInt(frac.padEnd(2, "0") || "0");
  if (cents > BigInt(Number.MAX_SAFE_INTEGER)) throw new Error("amount too large");
  return Number(cents);
}
