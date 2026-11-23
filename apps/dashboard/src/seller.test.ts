import { describe, expect, it } from "vitest";
import type { LoggedEvent } from "./api.js";
import { LIVE_RUNS } from "./liveRuns.js";
import { sellerMoments } from "./seller.js";

const at = "2026-11-02T12:00:00.000Z";
const ev = (seq: number, event: LoggedEvent["event"]): LoggedEvent => ({ seq, at, event });
const tx = "0x" + "d".repeat(64);
const mandate = "0x6908b0a2e62a939f6c16f3e899e4757d46033213fc9e57c50cb41c642c096374";

describe("sellerMoments", () => {
  it("a pass that checks out: who signed, the mandate, the cap against the price", () => {
    const [m] = sellerMoments([
      ev(1, {
        type: "pass_checked",
        ok: true,
        problems: [],
        url: "http://127.0.0.1:4021/query/fx-eurusd",
        amountCents: 5,
        buyer: {
          payer: "0x" + "c".repeat(40),
          ownerId: "own_customer",
          ownerKey: "1a2b3c4d5e6f7a8b",
          warrantId: "wrt_customer",
          mandateId: mandate,
          perPaymentCap: { currency: "USDZ", cents: 5 },
        },
      }),
    ]);
    expect(m?.ok).toBe(true);
    expect(m?.title).toBe("Buyer's warrant pass checked");
    expect(m?.rows).toEqual([
      { label: "Signed by", value: "owner own_customer · key 1a2b3c4d" },
      { label: "Mandate", value: "0x6908b0a2...", mono: true },
      { label: "Limit", value: "0.05 USDZ cap · price 0.05 USDZ" },
    ]);
  });

  it("a refused buyer says why, and that nothing was served or charged", () => {
    const [m] = sellerMoments([
      ev(2, {
        type: "pass_checked",
        ok: false,
        problems: ["no warrant pass: nothing shows an owner authorized this"],
        url: "http://127.0.0.1:4021/query/fx-eurusd",
        amountCents: 5,
      }),
    ]);
    expect(m?.ok).toBe(false);
    expect(m?.summary).toBe("Not served, not charged.");
    expect(m?.rows[0]?.value).toBe("no warrant pass: nothing shows an owner authorized this");
  });

  it("a dispute: counts, money back, and each order's decision with its settlement", () => {
    const [m] = sellerMoments([
      ev(3, {
        type: "dispute_decided",
        disputeId: "dsp_1",
        claim: "wrong_data",
        customer: "0x" + "c".repeat(40),
        refund: { currency: "USDZ", cents: 5 },
        orders: [
          {
            orderId: "ord_1",
            reason: "data_was_wrong",
            refundCents: 5,
            verified: true,
            txHash: tx,
          },
          { orderId: "ord_404", reason: "order_not_found", refundCents: 0, verified: false },
        ],
      }),
    ]);
    expect(m?.title).toBe("Dispute · wrong data");
    expect(m?.summary).toBe("2 orders · refund 1 · kept 1 · 0.05 USDZ back to the payer");
    expect(m?.rows).toEqual([
      { label: "ord_1", value: "refund 0.05 USDZ · data was wrong · on chain 0xdddddddd..." },
      { label: "ord_404", value: "kept · order not found" },
      { label: "Dispute", value: "dsp_1", mono: true },
    ]);
  });

  it("ignores payment events", () => {
    expect(
      sellerMoments([
        ev(4, {
          type: "approval_decided",
          proposalId: "p",
          ok: true,
          decision: "approved",
        }),
      ]),
    ).toEqual([]);
  });
});

describe("LIVE_RUNS", () => {
  it("every linked transaction is a full 32-byte hash", () => {
    const txs = LIVE_RUNS.flatMap((r) => r.steps.flatMap((s) => (s.tx ? [s.tx] : [])));
    expect(txs.length).toBeGreaterThan(0);
    for (const t of txs) expect(t).toMatch(/^0x[0-9a-f]{64}$/);
  });
});
