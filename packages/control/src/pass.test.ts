import { generateKeyPairSync } from "node:crypto";
import { describe, expect, it } from "vitest";
import type {
  PaymentProposal,
  SignedOrderRecord,
  WarrantBody,
  WarrantGrantBody,
  WarrantPassBody,
} from "@warrant/contracts";
import type { RailAdapter, RailInstruction, RailResult } from "@warrant/rails";
import { AGENT_BUDGETS, UPSTREAM_PRICE_BEFORE } from "./business.js";
import { Controller } from "./controller.js";
import { canonicalHash, signWarrant } from "./crypto.js";
import {
  PASS_HEADER,
  PassChecker,
  decodePass,
  encodePass,
  issueGrant,
  issuePass,
  keyB64,
  keyFingerprint,
  passIssuer,
  verifyEvidence,
  verifyPass,
} from "./pass/index.js";
import type { PassCheckedEvent, SaleExpectation } from "./pass/index.js";

const NOW = new Date("2026-11-01T12:00:00Z");
const usdz = (cents: number) => ({ currency: "USDZ" as const, cents });
const owner = generateKeyPairSync("ed25519");
const control = generateKeyPairSync("ed25519");
const PAYER = "0x" + "c".repeat(40);
const SELLER = "0x" + "b".repeat(40);
const URL = "http://127.0.0.1:4021/query/fx-eurusd";

const grantBody: WarrantGrantBody = {
  grantId: "grt_customer",
  warrantId: "wrt_customer",
  warrantVersion: 1,
  ownerId: "customer-owner",
  payer: PAYER,
  categories: ["data_purchase"],
  perPaymentCap: usdz(10),
  sellers: [SELLER],
  delegateKey: keyB64(control.publicKey),
  ownerKeyId: "owner-1",
  ownerKey: keyB64(owner.publicKey),
  notAfter: "2026-12-01T00:00:00Z",
};
const grant = issueGrant(grantBody, owner.privateKey);
const passBody = (over: Partial<WarrantPassBody> = {}): WarrantPassBody => ({
  grantId: grant.grantId,
  nonce: "n-1",
  url: URL,
  payTo: SELLER,
  amount: usdz(5),
  category: "data_purchase",
  proposalHash: "a".repeat(64),
  at: NOW.toISOString(),
  ...over,
});
const sale: SaleExpectation = {
  payTo: SELLER,
  url: URL,
  amountCents: 5,
  category: "data_purchase",
  payer: PAYER,
  now: NOW,
};
const passOf = (over: Partial<WarrantPassBody> = {}) =>
  issuePass(grant, passBody(over), control.privateKey);

describe("warrant pass: the seller's checks", () => {
  it("accepts a pass inside the owner's grant, and survives the header encoding", () => {
    const p = decodePass(encodePass(passOf()));
    expect(verifyPass(p, sale)).toMatchObject({ ok: true, problems: [] });
  });

  it("refuses no pass, and a header that is not a pass", () => {
    expect(verifyPass(undefined, sale).problems[0]).toMatch(/no warrant pass/);
    expect(decodePass("not base64 json")).toBeUndefined();
    expect(decodePass(Buffer.from('{"grant":{}}').toString("base64url"))).toBeUndefined();
  });

  it("refuses an edited grant (the agent raised its own cap)", () => {
    const p = passOf();
    const edited = { ...p, grant: { ...p.grant, perPaymentCap: usdz(1000) } };
    expect(verifyPass(edited, sale).problems).toContain("grant not signed by its owner");
  });

  it("refuses a pass signed by any key but the delegated one", () => {
    const rogue = generateKeyPairSync("ed25519");
    const p = issuePass(grant, passBody(), rogue.privateKey);
    expect(verifyPass(p, sale).problems).toContain(
      "pass not signed by the key the owner delegated",
    );
  });

  it("refuses a self-made owner once the payer's real owner is pinned", () => {
    const fake = generateKeyPairSync("ed25519");
    const fakeGrant = issueGrant(
      { ...grantBody, ownerKey: keyB64(fake.publicKey), delegateKey: keyB64(fake.publicKey) },
      fake.privateKey,
    );
    const p = issuePass(fakeGrant, passBody(), fake.privateKey);
    const pinned = new Map([[PAYER, grantBody.ownerKey]]);
    expect(verifyPass(p, { ...sale, pinned }).problems).toEqual([
      "owner key differs from the one this payer used before",
    ]);
  });

  it("refuses wrong price, seller, URL, category, payer, stale and replayed passes", () => {
    expect(verifyPass(passOf({ amount: usdz(2) }), sale).problems[0]).toMatch(/authorizes 2c/);
    expect(verifyPass(passOf({ amount: usdz(11) }), { ...sale, amountCents: 11 }).problems).toEqual(
      ["pass exceeds the owner's cap"],
    );
    expect(verifyPass(passOf({ payTo: PAYER }), sale).problems).toContain(
      "pass names another seller",
    );
    expect(verifyPass(passOf({ url: URL + "x" }), sale).problems).toContain(
      "pass is for another URL",
    );
    expect(verifyPass(passOf({ category: "licence_fee" }), sale).problems[0]).toMatch(
      /did not authorize/,
    );
    expect(verifyPass(passOf(), { ...sale, payer: SELLER }).problems).toContain(
      "paid from another account",
    );
    expect(verifyPass(passOf({ at: "2026-11-01T11:00:00Z" }), sale).problems).toContain(
      "pass is stale",
    );
    expect(verifyPass(passOf(), { ...sale, seen: new Set(["n-1"]) }).problems).toContain(
      "pass already used",
    );
  });

  it("the cap is inclusive: exactly the cap passes", () => {
    const p = passOf({ amount: usdz(10) });
    expect(verifyPass(p, { ...sale, amountCents: 10 }).ok).toBe(true);
  });
});

describe("PassChecker: a seller's memory", () => {
  const checker = () =>
    new PassChecker({ payTo: SELLER, category: "data_purchase", clock: () => NOW });

  it("a pass is good once; the replay is refused", () => {
    const c = checker();
    const h = encodePass(passOf({ nonce: "once" }));
    expect(c.check(h, URL, 5).ok).toBe(true);
    expect(c.check(h, URL, 5).problems).toEqual(["pass already used"]);
  });

  it("tells onCheck about every check: the grant's public facts, or why it was refused", () => {
    const seen: PassCheckedEvent[] = [];
    const c = new PassChecker({
      payTo: SELLER,
      category: "data_purchase",
      clock: () => NOW,
      onCheck: (e) => seen.push(e),
    });
    const mandateId = "0x" + "6".repeat(64);
    const named = issueGrant({ ...grantBody, mandateId }, owner.privateKey);
    const pass = issuePass(named, passBody({ nonce: "ev-1" }), control.privateKey);
    expect(c.check(encodePass(pass), URL, 5).ok).toBe(true);
    c.check(undefined, URL, 5);
    c.check("garbage", URL, 5);
    expect(seen[0]).toEqual({
      type: "pass_checked",
      ok: true,
      problems: [],
      url: URL,
      amountCents: 5,
      buyer: {
        payer: PAYER,
        ownerId: "customer-owner",
        ownerKey: keyFingerprint(keyB64(owner.publicKey)),
        warrantId: "wrt_customer",
        mandateId,
        perPaymentCap: usdz(10),
      },
    });
    expect(seen.slice(1).map((e) => [e.ok, e.buyer, e.problems[0]])).toEqual([
      [false, undefined, "no warrant pass: nothing shows an owner authorized this"],
      [false, undefined, "warrant pass unreadable"],
    ]);
  });

  it("an unreadable header is refused as such", () => {
    expect(checker().check("garbage", URL, 5)).toEqual({
      ok: false,
      problems: ["warrant pass unreadable"],
    });
  });

  it("pins a payer's owner key only after a settlement from that payer", () => {
    const c = checker();
    const fake = generateKeyPairSync("ed25519");
    const squatter = issuePass(
      issueGrant(
        { ...grantBody, ownerKey: keyB64(fake.publicKey), delegateKey: keyB64(fake.publicKey) },
        fake.privateKey,
      ),
      passBody({ nonce: "sq" }),
      fake.privateKey,
    );
    // Someone else claims PAYER's account first, but the payment came from elsewhere: no pin.
    expect(c.settled(encodePass(squatter), SELLER)).toBe("warrant pass names another payer");
    expect(c.check(encodePass(passOf({ nonce: "real-1" })), URL, 5).ok).toBe(true);
    expect(c.settled(encodePass(passOf({ nonce: "real-1" })), PAYER)).toBeUndefined();
    // Now the real owner is pinned, so a different owner key for PAYER is refused.
    const again = issuePass(squatter.grant, passBody({ nonce: "sq-2" }), fake.privateKey);
    expect(c.check(encodePass(again), URL, 5).problems).toContain(
      "owner key differs from the one this payer used before",
    );
  });
});

describe("dispute evidence from signatures alone", () => {
  const proposal = { proposalId: "prp_1", amount: usdz(5) };
  const order = (over: Partial<SignedOrderRecord> = {}): SignedOrderRecord => ({
    orderId: "ord_1",
    resource: "GET /query/fx-eurusd",
    price: usdz(5),
    payee: SELLER,
    payer: PAYER,
    network: "eip155:63825",
    txHash: "0x" + "1".repeat(64),
    settlementId: "s1",
    signedOffer: "{}",
    deliveredSha256: "d".repeat(64),
    at: NOW.toISOString(),
    ...over,
  });

  it("an order with its stored pass proves the owner authorized exactly this purchase", () => {
    const buyerPass = encodePass(passOf({ proposalHash: canonicalHash(proposal) }));
    const findings = verifyEvidence({
      order: order({ buyerPass }),
      proposal: proposal as unknown as PaymentProposal,
    });
    expect(findings.filter((f) => !f.ok)).toEqual([]);
    expect(findings.map((f) => f.what).join("\n")).toMatch(/proposal is the one this pass/);
  });

  it("a pass for another amount or payer does not prove this order", () => {
    const pass = passOf({ amount: usdz(3) });
    const bad = verifyEvidence({ order: order({ payer: SELLER }), pass }).filter((f) => !f.ok);
    expect(bad.map((f) => f.what)).toEqual([
      "the grant's payer is the account that paid",
      "the pass authorized exactly 5c",
    ]);
  });

  it("no pass: nothing shows the buyer's owner authorized the purchase", () => {
    expect(verifyEvidence({ order: order() }).at(-1)).toEqual({
      ok: false,
      what: "no warrant pass: nothing shows the buyer's owner authorized this purchase",
    });
  });
});

describe("buyer side: control carries a pass on its own purchases", () => {
  const ownerKeys = generateKeyPairSync("ed25519");
  const SELLER_URL = "http://127.0.0.1:4022/data";
  const UPSTREAM = "0x" + "1".repeat(40);
  const body: WarrantBody = {
    warrantId: "wrt_sourcing",
    version: 1,
    ownerId: "own_1",
    agentId: "agt_sourcing",
    agentRole: "sourcing",
    purpose: "Buy upstream market data to resell to customers.",
    allowedRails: ["metal_x402"],
    payees: [
      {
        payeeId: "pay_upstream",
        displayName: "Upstream data",
        rail: "metal_x402",
        routingRef: SELLER_URL,
        currency: "USDZ",
      },
    ],
    perPaymentCap: AGENT_BUDGETS.sourcing.perPaymentCap,
    totalBudget: AGENT_BUDGETS.sourcing.budget,
    notBefore: "2026-10-29T00:00:00Z",
    expiresAt: "2026-11-13T00:00:00Z",
    mandate: {
      network: "eip155:63825",
      mandateId: "mnd_1",
      principal: PAYER,
      cap: usdz(3),
      budget: usdz(1000),
      expiresAt: "2026-11-13T00:00:00Z",
    },
  };
  const ourGrant = issueGrant(
    {
      grantId: "grt_sourcing_v1",
      warrantId: body.warrantId,
      warrantVersion: body.version,
      ownerId: body.ownerId,
      payer: PAYER,
      categories: ["data_purchase"],
      perPaymentCap: body.perPaymentCap,
      sellers: [],
      delegateKey: keyB64(control.publicKey),
      ownerKeyId: "owner-k1",
      ownerKey: keyB64(ownerKeys.publicKey),
      notAfter: body.expiresAt,
    },
    ownerKeys.privateKey,
  );

  class FakeRail implements RailAdapter {
    readonly rail = "metal_x402" as const;
    calls: RailInstruction[] = [];
    execute(i: RailInstruction): Promise<RailResult> {
      this.calls.push(i);
      return Promise.resolve({ status: "succeeded", railRef: "0xtx" });
    }
    getStatus(): Promise<RailResult> {
      return Promise.resolve({ status: "unknown" });
    }
  }

  async function buy(version = 1) {
    const rail = new FakeRail();
    const warrant = signWarrant({ ...body, version }, ownerKeys.privateKey, "owner-k1");
    const controller = new Controller({
      ownerPublicKey: ownerKeys.publicKey,
      getWarrant: (id) => (id === warrant.warrantId ? warrant : undefined),
      rails: { metal_x402: rail },
      purpose: {
        model: "test-model",
        check: (_w, s, now) =>
          Promise.resolve({
            proposalId: s.proposalId,
            verdict: "consistent",
            reasons: ["matches_warrant_purpose"],
            explanation: "test",
            model: "test-model",
            evaluatedAt: now.toISOString(),
          }),
      },
      credentialFor: () => "sourcing.json",
      passFor: passIssuer({
        grant: ourGrant,
        delegateKey: control.privateKey,
        payToFor: (url) => (url === SELLER_URL ? UPSTREAM : undefined),
        clock: () => NOW,
      }),
      clock: () => NOW,
    });
    const p: PaymentProposal = {
      proposalId: "prop_pass",
      warrantId: "wrt_sourcing",
      agentId: "agt_sourcing",
      agentRole: "sourcing",
      rail: "metal_x402",
      payeeId: "pay_upstream",
      amount: UPSTREAM_PRICE_BEFORE,
      category: "data_purchase",
      recurrence: "one_off",
      idempotencyKey: "idem-pass-xxxxxxxx",
      justification: "hourly pull",
      createdAt: NOW.toISOString(),
    };
    await controller.submit(p);
    await controller.decideApproval({
      approvalId: "apr_pass",
      proposalId: p.proposalId,
      shownHash: controller.approvals.get(p.proposalId)?.shownHash ?? "",
      decision: "approved",
      ownerId: "own_1",
      decidedAt: NOW.toISOString(),
    });
    return { rail, p };
  }

  it("the paid request carries a pass the upstream seller accepts, tied to the proposal", async () => {
    const { rail, p } = await buy();
    expect(rail.calls).toHaveLength(1);
    const pass = decodePass(rail.calls[0]?.headers?.[PASS_HEADER]);
    expect(pass?.pass.proposalHash).toBe(canonicalHash(p));
    const check = verifyPass(pass, {
      payTo: UPSTREAM,
      url: SELLER_URL,
      amountCents: UPSTREAM_PRICE_BEFORE.cents,
      category: "data_purchase",
      payer: PAYER,
      now: NOW,
    });
    expect(check).toMatchObject({ ok: true, problems: [] });
  });

  it("a grant for another warrant version issues no pass (the seller then refuses)", async () => {
    const { rail } = await buy(2);
    expect(rail.calls).toHaveLength(1);
    expect(rail.calls[0]?.headers).toBeUndefined();
  });

  it("refuses to build an issuer whose key the owner did not delegate", () => {
    const rogue = generateKeyPairSync("ed25519");
    expect(() =>
      passIssuer({ grant: ourGrant, delegateKey: rogue.privateKey, payToFor: () => UPSTREAM }),
    ).toThrow(/delegate key/);
  });
});
