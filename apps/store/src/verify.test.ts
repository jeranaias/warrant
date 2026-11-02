import { describe, expect, it } from "vitest";
import type { MandateVerification } from "@metalntwx/metal-pay/mandates";
import type { SignedOrderRecord } from "@warrant/contracts";
import { settlementVerifier } from "./verify.js";

const STORE = `0x${"b".repeat(40)}` as const;
const PAYER = `0x${"c".repeat(40)}` as const;
const TX = "0x" + "d".repeat(64);
const REF = "0x" + "e".repeat(64);

const order: SignedOrderRecord = {
  orderId: "ord_1",
  resource: "GET /query/fx-eurusd",
  price: { currency: "USDZ", cents: 5 },
  payee: STORE,
  payer: PAYER,
  network: "eip155:63825",
  txHash: TX,
  settlementId: "set_1",
  signedOffer: "signed-offer-jwt",
  deliveredSha256: "a".repeat(64),
  at: "2026-11-02T12:00:00Z",
};

const verification = (over: Partial<MandateVerification> = {}): MandateVerification =>
  ({
    ok: true,
    steps: [{ step: 4, title: "", outcome: "pass", detail: "" }],
    mandate: { ref: REF, principal: `0x${"C".repeat(40)}` },
    payments: [
      {
        kind: "payment",
        txHash: TX,
        block: 1n,
        to: STORE,
        amount: 5n * 10n ** 16n,
        problems: [],
      },
    ],
    ...over,
  }) as MandateVerification;

describe("settlementVerifier (metal-pay verifyMandatePayment)", () => {
  it("holds for our price, to us, from the order's payer, and names the mandate", async () => {
    let asked: [string, string] | undefined;
    const check = settlementVerifier((tx, offer) => {
      asked = [tx, offer];
      return Promise.resolve(verification());
    });
    const r = await check(order);
    expect(asked).toEqual([TX, "signed-offer-jwt"]);
    expect(r.ok).toBe(true);
    expect(r.mandateId).toBe(REF);
    expect(r.detail).toContain("5c paid in 0xdddddddd...");
  });

  it("refuses a different amount, payee or payer, and a failed step", async () => {
    const pay = verification().payments[0];
    if (!pay) throw new Error("fixture");
    const cases: [MandateVerification, RegExp][] = [
      [verification({ payments: [{ ...pay, amount: 4n * 10n ** 16n }] }), /amount is not 5c/],
      [verification({ payments: [{ ...pay, to: PAYER }] }), /paid to another account/],
      [
        verification({
          mandate: { ref: REF, principal: STORE } as NonNullable<MandateVerification["mandate"]>,
        }),
        /another account than the order's payer/,
      ],
      [
        verification({ ok: false, steps: [{ step: 4, title: "", outcome: "fail", detail: "" }] }),
        /step 4 failed/,
      ],
      [verification({ payments: [] }), /no payment in the transaction/],
    ];
    for (const [v, why] of cases) {
      const r = await settlementVerifier(() => Promise.resolve(v))(order);
      expect(r.ok).toBe(false);
      expect(r.detail).toMatch(why);
    }
  });

  it("an RPC error never reaches the detail (it can carry the node's URL)", async () => {
    const r = await settlementVerifier(() =>
      Promise.reject(new Error("HTTP request failed. URL: https://rpc.example/secret-key")),
    )(order);
    expect(r).toEqual({ ok: false, detail: "could not read 0xdddddddd... from the chain" });
  });

  it("refuses an order whose tx is not a hash without asking the chain", async () => {
    let called = false;
    const r = await settlementVerifier(() => {
      called = true;
      return Promise.resolve(verification());
    })({ ...order, txHash: "stl_1" });
    expect(called).toBe(false);
    expect(r.ok).toBe(false);
  });
});
