import { z } from "zod";
import { AgentRole, Currency, Id, Money, Rail, Timestamp } from "./common.js";

/** A payee the owner pre-approved. Holds routing refs only, never card numbers or keys. */
export const Payee = z
  .object({
    payeeId: Id,
    displayName: z.string().min(1).max(120),
    rail: Rail,
    /** Metal: payTo address. Airwallex: beneficiary id or card merchant ref. */
    routingRef: z.string().min(1).max(256),
    currency: Currency,
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
