import { z } from "zod";
import { AgentRole, Currency, Id, Money, Rail, Timestamp } from "./common.js";

/**
 * How often a recurring payee bills, as the owner signed it (the licensor: once a month). A
 * second payment to the payee inside one period waits for the owner (control sets the lengths).
 */
export const BillingPeriod = z.enum(["day", "week", "month"]);
export type BillingPeriod = z.infer<typeof BillingPeriod>;

/** A payee the owner pre-approved. Holds routing refs only, never card numbers or keys. */
export const Payee = z
  .object({
    payeeId: Id,
    displayName: z.string().min(1).max(120),
    rail: Rail,
    /** Metal: payTo address. Airwallex: beneficiary id or card merchant ref. */
    routingRef: z.string().min(1).max(256),
    currency: Currency,
    /** Set for a payee that bills once per period. Absent: no period, paid as often as allowed. */
    billingPeriod: BillingPeriod.optional(),
  })
  .strict();
export type Payee = z.infer<typeof Payee>;

export const WarrantSignature = z
  .object({
    alg: z.enum(["ed25519"]),
    keyId: Id,
    /** base64 signature over the canonical JSON of WarrantBody. */
    sig: z.string().min(1),
  })
  .strict();
export type WarrantSignature = z.infer<typeof WarrantSignature>;

/**
 * The Metal mandate a metal_x402 warrant sits on (ADR-009). The mandate enforces limits on chain;
 * the warrant's limits must never exceed it. Ids only: never a key, a credential file or a path.
 */
export const MandateRef = z
  .object({
    network: z.enum(["eip155:63825"]),
    /** Mandate id as printed by `metal-agent` (`mandate <id>`). */
    mandateId: z.string().min(1).max(256),
    /** The owner's smart account the mandate pays from. */
    principal: z.string().regex(/^0x[0-9a-fA-F]{40}$/),
    cap: Money,
    budget: Money,
    expiresAt: Timestamp,
  })
  .strict();
export type MandateRef = z.infer<typeof MandateRef>;

/**
 * The owner's signed grant of authority to ONE agent. All limits are inclusive:
 * a payment exactly equal to perPaymentCap is allowed; one cent over is not.
 */
export const WarrantBody = z
  .object({
    warrantId: Id,
    version: z.number().int().positive(),
    ownerId: Id,
    agentId: Id,
    agentRole: AgentRole,
    /** Plain-language purpose written by the owner. Shown to the purpose checker. */
    purpose: z.string().min(1).max(1000),
    allowedRails: z.array(Rail).min(1),
    payees: z.array(Payee),
    perPaymentCap: Money,
    totalBudget: Money,
    notBefore: Timestamp,
    expiresAt: Timestamp,
    /** Required when allowedRails includes metal_x402 (checked in control). */
    mandate: MandateRef.optional(),
  })
  .strict();
export type WarrantBody = z.infer<typeof WarrantBody>;

export const WarrantStatus = z.enum(["active", "revoked", "expired", "superseded"]);
export type WarrantStatus = z.infer<typeof WarrantStatus>;

export const Warrant = WarrantBody.extend({
  signature: WarrantSignature,
  status: WarrantStatus,
}).strict();
export type Warrant = z.infer<typeof Warrant>;
