import { describe as group, expect, it } from "vitest";
import type { LoggedEvent, WarrantRow } from "./api.js";
import { OTHER, leftFraction, passesOf, payeeNodes, spread, tally } from "./flow.js";

const usd = (cents: number) => ({ currency: "USDZ" as const, cents });
const warrant = (warrantId: string, payees: string[]): WarrantRow => ({
  warrantId,
  version: 1,
  agentId: `agt_${warrantId}`,
  agentRole: "sourcing",
  purpose: "",
  allowedRails: [],
  payees: payees.map((payeeId) => ({
    payeeId,
    displayName: payeeId,
    rail: "metal_x402",
    currency: "USDZ",
  })),
  perPaymentCap: usd(10),
  totalBudget: usd(100),
  spentCents: 0,
});
const asked = (seq: number, warrantId: string, payeeId: string, outcome?: string): LoggedEvent =>
  ({
    seq,
    at: "2026-11-02T00:00:00Z",
    event: {
      type: "proposal",
      proposal: { warrantId, payeeId, amount: usd(5) },
      result: outcome ? { decision: { outcome } } : { error: "malformed" },
    },
  }) as unknown as LoggedEvent;

group("flow map data", () => {
  const warrants = [warrant("w1", ["pay_a"]), warrant("w2", [])];

  it("one node per named payee, plus customers when a warrant pays no one by name", () => {
    expect(payeeNodes(warrants).map((n) => n.id)).toEqual(["pay_a", OTHER]);
    expect(payeeNodes([warrant("w1", ["pay_a"])]).map((n) => n.id)).toEqual(["pay_a"]);
  });

  it("every proposal is paid, blocked or asks the owner; a malformed one counts as blocked", () => {
    const passes = passesOf(
      [
        asked(1, "w1", "pay_a", "execute"),
        asked(2, "w1", "pay_x", "blocked"),
        asked(3, "w2", "cus_1", "needs_owner_approval"),
        asked(4, "w2", "cus_1"),
      ],
      warrants,
    );
    expect(passes.map((p) => [p.payee, p.fate])).toEqual([
      ["pay_a", "paid"],
      [OTHER, "blocked"],
      [OTHER, "asked"],
      [OTHER, "blocked"],
    ]);
    const t = tally(passes);
    expect(t.total).toEqual({ paid: 1, blocked: 2, asked: 1 });
    expect(t.lanes.get("w2")).toEqual({ paid: 0, blocked: 1, asked: 1 });
    expect(t.paidTo.get("pay_a")).toEqual(usd(5));
  });

  it("spreads nodes evenly around the middle", () => {
    expect(spread(1, 340, 100)).toEqual([170]);
    expect(spread(3, 340, 100)).toEqual([70, 170, 270]);
  });

  it("budget left is a share from 0 to 1, never outside it", () => {
    expect(leftFraction(0, 1000)).toBe(1);
    expect(leftFraction(250, 1000)).toBe(0.75);
    expect(leftFraction(1500, 1000)).toBe(0);
    expect(leftFraction(5, 0)).toBe(0);
  });
});
