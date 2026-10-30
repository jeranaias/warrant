import { z } from "zod";
import { Id, Money, Rail, Timestamp } from "./common.js";

const Sha256Hex = z.string().regex(/^[0-9a-f]{64}$/);

/**
 * Append-only. Lifecycle of every outbound payment:
 *   reserve -> rail call -> confirm | release
 * A rail timeout writes `unconfirmed` and keeps the reservation held until a status check
 * resolves it. It is never silently released and never retried blind.
 */
export const LedgerEntryType = z.enum([
  "reserve",
  "confirm",
  "release",
  "unconfirmed",
  "inbound", // revenue or a refund received
  "kill_switch",
]);
export type LedgerEntryType = z.infer<typeof LedgerEntryType>;

export const LedgerEntry = z
  .object({
    seq: z.number().int().nonnegative(),
    entryId: Id,
    type: LedgerEntryType,
    /** confirm / release / unconfirmed: the reserve entry this resolves. */
    reservationId: Id.optional(),
    proposalId: Id.optional(),
    warrantId: Id.optional(),
    rail: Rail.optional(),
    /** reserve: the warrant payee (or refunded order id) the money is for. Duplicate guard keys on it. */
    payeeId: Id.optional(),
    amount: Money,
    /** Rail-side reference (tx hash, Airwallex transfer id). Never a card PAN or CVV. */
    railRef: z.string().max(256).optional(),
    idempotencyKey: z.string().max(128).optional(),
    /** Hash chain for tamper evidence: sha256(prevHash + canonical(entry without hash)). */
    prevHash: Sha256Hex,
    hash: Sha256Hex,
    at: Timestamp,
  })
  .strict();
export type LedgerEntry = z.infer<typeof LedgerEntry>;
