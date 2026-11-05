import { describe, expect, it } from "vitest";
import { AirwallexClient } from "@warrant/rails";
import { earningsScene, licensorBeneficiary, mockAirwallexWorld } from "./earnings.js";

/** A client that logs in, then answers the beneficiary read as given; records every other call. */
function beneficiaryStub(read: { status: number; body?: unknown }) {
  const calls: string[] = [];
  const fetch = ((url: string, init: RequestInit) => {
    const u = new URL(url);
    if (u.pathname.endsWith("/authentication/login")) {
      return Promise.resolve(new Response(JSON.stringify({ token: "t" }), { status: 201 }));
    }
    calls.push(`${init.method ?? "GET"} ${u.pathname}`);
    if (u.pathname === "/api/v1/beneficiaries/create") {
      return Promise.resolve(new Response(JSON.stringify({ id: "ben_new" }), { status: 201 }));
    }
    return Promise.resolve(new Response(JSON.stringify(read.body ?? {}), { status: read.status }));
  }) as typeof globalThis.fetch;
  const client = new AirwallexClient({
    baseUrl: "http://awx.test",
    clientId: "c",
    apiKey: "k",
    fetch,
  });
  return { client, calls };
}

describe("licensorBeneficiary", () => {
  it.each([401, 403, 429, 500, 503])(
    "a %i on the beneficiary read throws naming the status and creates nothing",
    async (status) => {
      const { client, calls } = beneficiaryStub({ status, body: { code: "nope" } });
      await expect(licensorBeneficiary(client)).rejects.toThrow(`HTTP ${status}`);
      expect(calls.some((c) => c.endsWith("/beneficiaries/create"))).toBe(false);
    },
  );

  it("a 200 that lists the licensor by nickname returns its id and creates nothing", async () => {
    const { client, calls } = beneficiaryStub({
      status: 200,
      body: { items: [{ id: "ben_1", nickname: "Data Licensor GmbH (SWIFT)" }] },
    });
    expect(await licensorBeneficiary(client)).toBe("ben_1");
    expect(calls.some((c) => c.endsWith("/beneficiaries/create"))).toBe(false);
  });

  it("a 200 with no match creates the licensor once", async () => {
    const { client, calls } = beneficiaryStub({ status: 200, body: { items: [] } });
    expect(await licensorBeneficiary(client)).toBe("ben_new");
    expect(calls.filter((c) => c.endsWith("/beneficiaries/create"))).toHaveLength(1);
  });

  it("the mock's 404 (it has no list route) creates the licensor", async () => {
    const { client, calls } = beneficiaryStub({ status: 404 });
    expect(await licensorBeneficiary(client)).toBe("ben_new");
    expect(calls.filter((c) => c.endsWith("/beneficiaries/create"))).toHaveLength(1);
  });
});

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
        [
          "the simulator moves it to PAID",
          "PAID; ledger confirmed; fee paid from cash already in the wallet",
        ],
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
