import { describe, expect, it } from "vitest";
import { earningsScene, mockAirwallexWorld } from "./earnings.js";

describe("earnings scene (both rails, one ledger)", () => {
  it("sweeps Metal earnings, deposits them, pays the EUR fee by FX + transfer, then confirms", async () => {
    const awx = await mockAirwallexWorld(new Date("2026-11-01T12:00:00Z"));
    try {
      const steps = await earningsScene(() => new Date("2026-11-01T12:00:00Z"), awx);
      expect(steps.map((s) => [s.step, s.outcome])).toEqual([
        ["store earnings off Metal (mandate pull)", "15c to our treasury address"],
        ["deposit into Airwallex", "15c USD, reference = the Metal tx"],
        [
          "treasury pays the EUR 50 licence fee",
          "pending (SCHEDULED): USD converted to EUR, transfer sent",
        ],
        ["the bank pays it out", "PAID; ledger confirmed"],
      ]);
      expect(steps[0]?.tx).toMatch(/^0x[0-9a-f]{64}$/);

      // The wallet: 60.15 USD in, 56.13 USD sold for 50.00 EUR, 50.00 EUR paid out.
      const rows = (await awx.client.call("GET", "/api/v1/balances/current")).body as {
        currency: string;
        available_amount: number;
      }[];
      const bal = Object.fromEntries(rows.map((r) => [r.currency, r.available_amount]));
      expect(bal).toEqual({ USD: 4.02, EUR: 0 });
    } finally {
      await awx.close();
    }
  });

  it("a retried licence fee never pays twice: the reused request id finds the first transfer", async () => {
    const awx = await mockAirwallexWorld();
    try {
      const rail = awx.world.rails.airwallex_transfer;
      const ref = awx.world.warrants.get("wrt_treasury")?.payees[0]?.routingRef ?? "";
      const i = {
        rail: "airwallex_transfer" as const,
        reservationId: "res_1",
        idempotencyKey: "fee-retry-1",
        amount: { currency: "EUR" as const, cents: 5000 },
        routingRef: ref,
      };
      const first = await rail.execute(i);
      const again = await rail.execute(i);
      expect(first.status).toBe("pending");
      expect(again.railRef).toBe(first.railRef);
      const transfers = (await awx.client.call("GET", "/api/v1/transfers")).body as {
        items: unknown[];
      };
      expect(transfers.items).toHaveLength(1);
    } finally {
      await awx.close();
    }
  });
});
