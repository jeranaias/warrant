import { z } from "zod";
import { Id, Money, Timestamp } from "./common.js";
import { SpendCategory } from "./proposal.js";

const Address = z.string().regex(/^0x[0-9a-fA-F]{40}$/);
const Sha256Hex = z.string().regex(/^[0-9a-f]{64}$/);
/** An ed25519 public key as SPKI DER, base64. */
const PublicKeyB64 = z.string().min(1).max(200);
const SigB64 = z.string().min(1).max(200);

/**
 * The public part of a warrant that a seller may see (ADR-012). The owner signs it once. It names
 * the paying account, the categories and the per-payment cap, and the key allowed to sign passes
 * under it (control's). Never budgets, spend so far or other payees.
 */
export const WarrantGrantBody = z
  .object({
    grantId: Id,
    warrantId: Id,
    warrantVersion: z.number().int().positive(),
    ownerId: Id,
    /** The account the seller sees paying (the warrant's Metal mandate principal). */
    payer: Address,
    /**
     * The Metal mandate the payer pays under (`MandateRef.mandateId`), when the warrant has one.
     * A seller can check the settlement on chain names this mandate. Public: it is on chain.
     */
    mandateId: z.string().min(1).max(256).optional(),
    categories: z.array(SpendCategory).min(1),
    perPaymentCap: Money,
    /** Seller addresses the grant covers; empty means any seller (categories and cap still apply). */
    sellers: z.array(Address).max(100),
    /** The key allowed to sign passes under this grant (control's). */
    delegateKey: PublicKeyB64,
    ownerKeyId: Id,
    /** The owner's public key. Sellers pin it per payer. */
    ownerKey: PublicKeyB64,
    notAfter: Timestamp,
  })
  .strict();
export type WarrantGrantBody = z.infer<typeof WarrantGrantBody>;

export const WarrantGrant = WarrantGrantBody.extend({
  /** ed25519 by `ownerKey` over the canonical JSON of WarrantGrantBody. */
  ownerSig: SigB64,
}).strict();
export type WarrantGrant = z.infer<typeof WarrantGrant>;

/** One purchase, signed by the grant's delegated key just before control pays. */
export const WarrantPassBody = z
  .object({
    grantId: Id,
    /** Single use: sellers refuse a nonce they have seen. */
    nonce: Id,
    /** The exact URL paid for. */
    url: z.string().min(1).max(2000),
    /** The seller's address (x402 payTo). */
    payTo: Address,
    amount: Money,
    category: SpendCategory,
    /** sha256 of the canonical PaymentProposal: links the pass to the buyer's own records. */
    proposalHash: Sha256Hex,
    at: Timestamp,
  })
  .strict();
export type WarrantPassBody = z.infer<typeof WarrantPassBody>;

/** Sent base64url-encoded as the `x-warrant-pass` header on the paid request. */
export const WarrantPass = z
  .object({
    grant: WarrantGrant,
    pass: WarrantPassBody,
    /** ed25519 by `grant.delegateKey` over the canonical JSON of `pass`. */
    sig: SigB64,
  })
  .strict();
export type WarrantPass = z.infer<typeof WarrantPass>;
