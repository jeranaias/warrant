import { generateKeyPairSync } from "node:crypto";
import { describe, expect, it } from "vitest";
import type { DisputeCase, SignedOrderRecord } from "@warrant/contracts";
import { decideDispute, disputeDecidedEvent } from "./disputes/index.js";
import type { DisputeInputs } from "./disputes/index.js";
import { encodePass, issueGrant, issuePass, keyB64 } from "./pass/index.js";

const NOW = new Date("2026-11-01T12:00:00Z");
const CUSTOMER = "0x" + "c".repeat(40);
const STORE = "0x" + "5".repeat(40);
const usdz = (cents: number) => ({ currency: "USDZ" as const, cents });

const owner = generateKeyPairSync("ed25519");
const control = generateKeyPairSync("ed25519");
const grant = issueGrant(
  {
    grantId: "grt_c",
    warrantId: "wrt_c",
    warrantVersion: 1,
    ownerId: "own_c",
    payer: CUSTOMER,
    categories: ["data_purchase"],
    perPaymentCap: usdz(5),
    sellers: [STORE],
    delegateKey: keyB64(control.publicKey),
    ownerKeyId: "k1",
    ownerKey: keyB64(owner.publicKey),
    notAfter: "2026-12-01T00:00:00Z",
  },
  owner.privateKey,
);
const passFor = (orderId: string, signer = control.privateKey) =>
  encodePass(
    issuePass(
      grant,
      {
        grantId: "grt_c",
        nonce: `n_${orderId}`,
        url: "http://127.0.0.1:4021/query/fx-eurusd",
        payTo: STORE,
        amount: usdz(5),
        category: "data_purchase",
        proposalHash: "a".repeat(64),
        at: NOW.toISOString(),
      },
      signer,
    ),
  );

const order = (orderId: string, over: Partial<SignedOrderRecord> = {}): SignedOrderRecord => ({
  orderId,
  resource: "GET /query/fx-eurusd",
  price: usdz(5),
  payee: STORE,
  payer: CUSTOMER,
  network: "eip155:63825",
  txHash: "0x" + "d".repeat(64),
  settlementId: `stl_${orderId}`,
  signedOffer: "{}",
  deliveredSha256: "e".repeat(64),
  upstreamBatchId: "bat_good",
  buyerPass: passFor(orderId),
  at: NOW.toISOString(),
  ...over,
});

const orders = new Map(
  [
    order("ord_bad", { upstreamBatchId: "bat_stale" }),
    order("ord_good"),
    order("ord_forged", {
      buyerPass: passFor("ord_forged", generateKeyPairSync("ed25519").privateKey),
    }),
    order("ord_nopass", { buyerPass: undefined }),
    order("ord_other", { payer: "0x" + "9".repeat(40) }),
    order("ord_unsettled", { txHash: "0x" + "f".repeat(64) }),
  ].map((o) => [o.orderId, o]),
);

const run = (claim: DisputeCase["claim"], orderIds: string[], over: Partial<DisputeInputs> = {}) =>
  decideDispute({
    dispute: {
      disputeId: "dsp_1",
      customer: CUSTOMER,
      orderIds,
      claim,
      ticketRef: "tkt_1",
      openedAt: NOW.toISOString(),
    },
    orders,
    refunded: new Set(),
    badBatches: new Set(["bat_stale"]),
    verifySettlement: (o) =>
      Promise.resolve(
        o.txHash.endsWith("d")
          ? { ok: true, detail: "settlement on chain" }
          : { ok: false, detail: "no settlement matches" },
      ),
    now: NOW,
    ...over,
  });

const reasons = (f: Awaited<ReturnType<typeof run>>) =>
  f.findings.map((x) => [x.orderId, x.decision.reason, x.decision.refund.cents]);

describe("disputes: the store decides from its records", () => {
  it("wrong data: refunds what came from a bad batch, stands by the rest", async () => {
    const f = await run("wrong_data", ["ord_bad", "ord_good", "ord_bad"]);
    expect(reasons(f)).toEqual([
      ["ord_bad", "data_was_wrong", 5],
      ["ord_good", "data_was_correct", 0],
    ]);
    expect(f.refund).toEqual(usdz(5));
  });

  it("never refunds an unknown order, someone else's, an unsettled one, or one already refunded", async () => {
    const f = await run("wrong_data", ["ord_404", "ord_other", "ord_unsettled", "ord_bad"], {
      refunded: new Set(["ord_bad"]),
    });
    expect(reasons(f)).toEqual([
      ["ord_404", "order_not_found", 0],
      ["ord_other", "not_customers_order", 0],
      ["ord_unsettled", "signature_check_failed", 0],
      ["ord_bad", "already_refunded", 0],
    ]);
    expect(f.refund.cents).toBe(0);
  });

  it("'my agent never agreed': a pass the customer's owner signed stands; a missing or forged one does not", async () => {
    const f = await run("not_authorized", ["ord_good", "ord_nopass", "ord_forged"]);
    expect(reasons(f)).toEqual([
      ["ord_good", "owner_authorized", 0],
      ["ord_nopass", "authorization_not_proven", 5],
      ["ord_forged", "authorization_not_proven", 5],
    ]);
    const forged = f.findings[2]?.evidence.filter((e) => !e.ok).map((e) => e.what);
    expect(forged).toEqual(["the owner's delegated key signed this purchase"]);
  });
});

describe("dispute_decided: the decision as one event line", () => {
  it("per order: refund or kept, the reason code, the settlement tx when verified", async () => {
    const f = await run("wrong_data", ["ord_bad", "ord_good", "ord_404"]);
    const e = disputeDecidedEvent(
      {
        disputeId: "dsp_1",
        customer: CUSTOMER,
        orderIds: ["ord_bad", "ord_good", "ord_404"],
        claim: "wrong_data",
        ticketRef: "tkt_1",
        openedAt: NOW.toISOString(),
      },
      f,
      orders,
    );
    const tx = "0x" + "d".repeat(64);
    expect(e).toEqual({
      type: "dispute_decided",
      disputeId: "dsp_1",
      claim: "wrong_data",
      customer: CUSTOMER,
      refund: usdz(5),
      orders: [
        {
          orderId: "ord_bad",
          reason: "data_was_wrong",
          refundCents: 5,
          verified: true,
          txHash: tx,
        },
        {
          orderId: "ord_good",
          reason: "data_was_correct",
          refundCents: 0,
          verified: true,
          txHash: tx,
        },
        { orderId: "ord_404", reason: "order_not_found", refundCents: 0, verified: false },
      ],
    });
  });
});
