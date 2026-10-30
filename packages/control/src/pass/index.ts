import { createHash, createPublicKey, randomUUID, sign, verify } from "node:crypto";
import type { KeyObject } from "node:crypto";
import { WarrantGrantBody, WarrantPass, WarrantPassBody } from "@warrant/contracts";
import type {
  PaymentProposal,
  SignedOrderRecord,
  SpendCategory,
  Warrant,
  WarrantGrant,
} from "@warrant/contracts";
import { canonicalHash, canonicalize } from "../crypto.js";

/**
 * The warrant pass (ADR-012). A seller normally sees a payment and nothing about who authorized
 * it. With a pass, the buying agent's request carries proof of its owner's authority:
 *
 *   owner   --signs--> WarrantGrant  (once: payer, categories, per-payment cap, delegated key;
 *                                     never budgets, never other payees)
 *   control --signs--> WarrantPass   (per purchase: seller, URL, amount, category, nonce,
 *                                     proposal hash), sent as the `x-warrant-pass` header
 *
 * The seller checks both signatures and the fit to the grant before it serves. Refusing (>= 400)
 * cancels the x402 payment, so an unauthorized buyer is never charged. The seller stores the pass
 * with the signed order, and a later dispute is settled from signatures, not anyone's say-so.
 */

export const PASS_HEADER = "x-warrant-pass";

/** A header longer than this is refused unread. */
const MAX_HEADER_CHARS = 20_000;
const DEFAULT_MAX_AGE_MS = 5 * 60 * 1000;
/** Clock skew allowed between buyer and seller. */
const SKEW_MS = 60 * 1000;

export function keyB64(k: KeyObject): string {
  const pub = k.type === "public" ? k : createPublicKey(k);
  return pub.export({ type: "spki", format: "der" }).toString("base64");
}

/** Short owner-key id for records and display. */
export function keyFingerprint(b64: string): string {
  return createHash("sha256").update(Buffer.from(b64, "base64")).digest("hex").slice(0, 16);
}

function keyFrom(b64: string): KeyObject {
  return createPublicKey({ key: Buffer.from(b64, "base64"), format: "der", type: "spki" });
}

function signed(body: object, key: KeyObject): string {
  return sign(null, Buffer.from(canonicalize(body), "utf8"), key).toString("base64");
}

function sigValid(body: object, sig: string, b64: string): boolean {
  try {
    return verify(
      null,
      Buffer.from(canonicalize(body), "utf8"),
      keyFrom(b64),
      Buffer.from(sig, "base64"),
    );
  } catch {
    return false;
  }
}

/** The owner signs the grant. Done once per warrant version, outside control. */
export function issueGrant(body: WarrantGrantBody, ownerPrivateKey: KeyObject): WarrantGrant {
  const parsed = WarrantGrantBody.parse(body);
  return { ...parsed, ownerSig: signed(parsed, ownerPrivateKey) };
}

/** Control signs one purchase under the grant with the delegated key. */
export function issuePass(
  grant: WarrantGrant,
  body: WarrantPassBody,
  delegatePrivateKey: KeyObject,
): WarrantPass {
  const parsed = WarrantPassBody.parse(body);
  return { grant, pass: parsed, sig: signed(parsed, delegatePrivateKey) };
}

export function encodePass(p: WarrantPass): string {
  return Buffer.from(JSON.stringify(p), "utf8").toString("base64url");
}

/** The pass in a header, or undefined if it is missing, too long or not a pass. */
export function decodePass(header: string | undefined): WarrantPass | undefined {
  if (!header || header.length > MAX_HEADER_CHARS) return undefined;
  try {
    const r = WarrantPass.safeParse(JSON.parse(Buffer.from(header, "base64url").toString("utf8")));
    return r.success ? r.data : undefined;
  } catch {
    return undefined;
  }
}

// ---- buyer side ----

export interface PassIssuerOptions {
  /** The owner's signed grant for the warrant control pays under. */
  grant: WarrantGrant;
  /** The private half of `grant.delegateKey`. Stays in control. */
  delegateKey: KeyObject;
  /** The seller's address (x402 payTo) for a seller URL, or undefined if unknown. */
  payToFor: (url: string) => string | undefined;
  clock?: () => Date;
}

/**
 * Builds the `passFor` hook for the Controller: headers for one approved metal_x402 purchase.
 * Returns undefined (no pass) when the grant does not cover this warrant or purchase; a seller
 * that checks passes then refuses before the payment settles. Never throws.
 */
export function passIssuer(
  opts: PassIssuerOptions,
): (
  warrant: Warrant,
  proposal: PaymentProposal,
  url: string,
) => Record<string, string> | undefined {
  if (keyB64(opts.delegateKey) !== opts.grant.delegateKey) {
    throw new Error("delegate key does not match the grant");
  }
  const clock = opts.clock ?? (() => new Date());
  return (warrant, proposal, url) => {
    const { grant } = opts;
    if (grant.warrantId !== warrant.warrantId || grant.warrantVersion !== warrant.version) {
      return undefined;
    }
    try {
      const payTo = opts.payToFor(url);
      if (!payTo) return undefined;
      const pass = issuePass(
        grant,
        {
          grantId: grant.grantId,
          nonce: randomUUID(),
          url: normalUrl(url),
          payTo,
          amount: proposal.amount,
          category: proposal.category,
          proposalHash: canonicalHash(proposal),
          at: clock().toISOString(),
        },
        opts.delegateKey,
      );
      return { [PASS_HEADER]: encodePass(pass) };
    } catch {
      return undefined;
    }
  };
}

// ---- seller side ----

/** What the seller expects of this sale. */
export interface SaleExpectation {
  /** The seller's own address. */
  payTo: string;
  url: string;
  amountCents: number;
  /** What the seller sells. */
  category: SpendCategory;
  /** The paying account, when the seller knows it before serving. */
  payer?: string;
  now: Date;
  /** payer (lower case) -> owner key the seller has seen settle before. A different key is refused. */
  pinned?: ReadonlyMap<string, string>;
  /** Nonces already accepted (replay guard). */
  seen?: { has(nonce: string): boolean };
  /** How old a pass may be. Default 5 minutes. */
  maxAgeMs?: number;
}

export interface PassCheck {
  ok: boolean;
  /** Every problem found; any one refuses the sale. */
  problems: string[];
  /** Owner-key fingerprint, when a pass was readable. */
  owner?: string;
}

const lower = (s: string) => s.toLowerCase();

/** The seller's checks on a decoded pass. Pure: the caller keeps pins and seen nonces. */
export function verifyPass(p: WarrantPass | undefined, e: SaleExpectation): PassCheck {
  if (!p)
    return { ok: false, problems: ["no warrant pass: nothing shows an owner authorized this"] };
  const problems: string[] = [];
  const { grant, pass } = p;
  const { ownerSig, ...grantBody } = grant;
  if (!sigValid(grantBody, ownerSig, grant.ownerKey))
    problems.push("grant not signed by its owner");
  if (!sigValid(pass, p.sig, grant.delegateKey)) {
    problems.push("pass not signed by the key the owner delegated");
  }
  const pinnedKey = e.pinned?.get(lower(grant.payer));
  if (pinnedKey !== undefined && pinnedKey !== grant.ownerKey) {
    problems.push("owner key differs from the one this payer used before");
  }
  if (pass.grantId !== grant.grantId) problems.push("pass is for a different grant");
  if (e.payer !== undefined && lower(e.payer) !== lower(grant.payer)) {
    problems.push("paid from another account");
  }
  if (lower(pass.payTo) !== lower(e.payTo)) problems.push("pass names another seller");
  if (grant.sellers.length > 0 && !grant.sellers.map(lower).includes(lower(e.payTo))) {
    problems.push("grant does not cover this seller");
  }
  if (normalUrl(pass.url) !== normalUrl(e.url)) problems.push("pass is for another URL");
  if (pass.amount.cents !== e.amountCents) {
    problems.push(`pass authorizes ${pass.amount.cents}c, the price is ${e.amountCents}c`);
  }
  // Inclusive, like every limit: exactly the cap passes.
  if (pass.amount.cents > grant.perPaymentCap.cents) problems.push("pass exceeds the owner's cap");
  if (pass.amount.currency !== grant.perPaymentCap.currency)
    problems.push("pass in another currency");
  if (!grant.categories.includes(pass.category) || pass.category !== e.category) {
    problems.push(`owner did not authorize ${e.category}`);
  }
  if (e.now.getTime() > Date.parse(grant.notAfter)) problems.push("grant expired");
  const age = e.now.getTime() - Date.parse(pass.at);
  if (!(age >= -SKEW_MS && age <= (e.maxAgeMs ?? DEFAULT_MAX_AGE_MS)))
    problems.push("pass is stale");
  if (e.seen?.has(pass.nonce)) problems.push("pass already used");
  return { ok: problems.length === 0, problems, owner: keyFingerprint(grant.ownerKey) };
}

export interface PassCheckerOptions {
  /** The seller's own address. */
  payTo: string;
  /** What the seller sells. */
  category: SpendCategory;
  clock?: () => Date;
  maxAgeMs?: number;
}

/**
 * A seller's pass checks with their memory: seen nonces (replay) and each payer's owner key.
 * A key is pinned only once a settlement shows that payer really paid under it (`settled`), so a
 * stranger can't claim someone else's account first and lock its real owner out.
 */
export class PassChecker {
  private readonly pinned = new Map<string, string>();
  private readonly seen = new Map<string, number>();
  private readonly clock: () => Date;

  constructor(private readonly opts: PassCheckerOptions) {
    this.clock = opts.clock ?? (() => new Date());
  }

  /** Before serving. On success the nonce is spent. */
  check(header: string | undefined, url: string, amountCents: number): PassCheck {
    const now = this.clock();
    this.forgetOld(now);
    const p = decodePass(header);
    const r = verifyPass(p, {
      payTo: this.opts.payTo,
      url,
      amountCents,
      category: this.opts.category,
      now,
      pinned: this.pinned,
      seen: this.seen,
      ...(this.opts.maxAgeMs !== undefined ? { maxAgeMs: this.opts.maxAgeMs } : {}),
    });
    if (header && !p) return { ok: false, problems: ["warrant pass unreadable"] };
    if (r.ok && p) this.seen.set(p.pass.nonce, Date.parse(p.pass.at));
    return r;
  }

  /**
   * After settlement, with the account that actually paid. Pins the payer's owner key when the
   * grant names that payer; otherwise returns the problem, for the operator and the dispute file.
   */
  settled(header: string | undefined, payer: string): string | undefined {
    const p = decodePass(header);
    if (!p) return "settled without a readable warrant pass";
    if (lower(p.grant.payer) !== lower(payer)) return "warrant pass names another payer";
    if (!this.pinned.has(lower(payer))) this.pinned.set(lower(payer), p.grant.ownerKey);
    return undefined;
  }

  /** A nonce older than the age limit can't come back: its pass is stale by then. */
  private forgetOld(now: Date): void {
    const cutoff = now.getTime() - (this.opts.maxAgeMs ?? DEFAULT_MAX_AGE_MS) - SKEW_MS;
    for (const [nonce, at] of this.seen) if (at < cutoff) this.seen.delete(nonce);
  }
}

// ---- dispute evidence ----

export interface EvidenceBundle {
  order: SignedOrderRecord;
  /** Defaults to the pass stored with the order. */
  pass?: WarrantPass;
  /** The buyer's own proposal, if they produce it: checked against the pass's proposal hash. */
  proposal?: PaymentProposal;
}

export interface EvidenceFinding {
  ok: boolean;
  what: string;
}

/**
 * What either side (or an arbiter) can establish from the bundle alone. Every line is checked
 * against a signature or a hash, never taken on trust. The settlement itself is checked separately
 * with metal-pay's `verifyMandatePayment`.
 */
export function verifyEvidence(b: EvidenceBundle): EvidenceFinding[] {
  const out: EvidenceFinding[] = [];
  const add = (ok: boolean, what: string) => out.push({ ok, what });
  add(b.order.signedOffer.length > 0, "the buyer's agent signed the offer it paid (signed order)");
  add(
    /^[0-9a-f]{64}$/.test(b.order.deliveredSha256),
    "the seller recorded a hash of what it delivered",
  );
  const wp = b.pass ?? decodePass(b.order.buyerPass);
  if (!wp) {
    add(false, "no warrant pass: nothing shows the buyer's owner authorized this purchase");
    return out;
  }
  const { grant, pass } = wp;
  const { ownerSig, ...grantBody } = grant;
  add(
    sigValid(grantBody, ownerSig, grant.ownerKey),
    `owner ${keyFingerprint(grant.ownerKey)} signed the grant`,
  );
  add(sigValid(pass, wp.sig, grant.delegateKey), "the owner's delegated key signed this purchase");
  add(lower(grant.payer) === lower(b.order.payer), "the grant's payer is the account that paid");
  add(lower(pass.payTo) === lower(b.order.payee), "the pass names the seller that was paid");
  add(pathOf(pass.url) === b.order.resource.split(" ")[1], `the pass is for ${b.order.resource}`);
  add(
    pass.amount.cents === b.order.price.cents,
    `the pass authorized exactly ${b.order.price.cents}c`,
  );
  add(
    grant.categories.includes(pass.category) && pass.amount.cents <= grant.perPaymentCap.cents,
    `the owner authorized ${pass.category} up to ${grant.perPaymentCap.cents}c a payment`,
  );
  add(
    Date.parse(pass.at) <= Date.parse(grant.notAfter),
    "the grant was in force when the pass was signed",
  );
  if (b.proposal) {
    add(
      canonicalHash(b.proposal) === pass.proposalHash,
      "the buyer's proposal is the one this pass was signed for",
    );
  }
  return out;
}

function normalUrl(u: string): string {
  try {
    return new URL(u).toString();
  } catch {
    return u;
  }
}

function pathOf(u: string): string | undefined {
  try {
    return new URL(u).pathname;
  } catch {
    return undefined;
  }
}
