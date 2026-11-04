import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import type { PaymentProposal } from "@warrant/contracts";
import { startAirwallexMock } from "@warrant/mocks/airwallex";
import { AirwallexClient, AirwallexTransfers, simulateTransfer } from "@warrant/rails";
import { airwallexConfigFromEnv, liveConfigFromEnv } from "./config.js";
import { LICENSOR_SWIFT } from "./earnings.js";
import { liveModeLabel, makeLiveAirwallex } from "./live.js";
import { createEngine } from "./server.js";
import { AGENTS, AlwaysPaysRail, bodies, makeWorld } from "./world.js";

const NOW = new Date("2026-11-04T12:00:00Z");
const EURUSD = "1.122579";

const home = mkdtempSync(join(tmpdir(), "warrant-live-test-"));
const baseMetalEnv = (extra: Record<string, string | undefined> = {}): NodeJS.ProcessEnv => ({
  METAL_HOME: home,
  METAL_RPC_URL: "http://rpc.testnet.invalid/secret-rpc-token",
  METAL_STORE_ADDRESS: "0x" + "5".repeat(40),
  METAL_UPSTREAM_ADDRESS: "0x" + "b".repeat(40),
  ...extra,
});

const licenceProposal = (idempotencyKey: string): PaymentProposal => ({
  proposalId: `prop_${idempotencyKey}`,
  warrantId: AGENTS.treasury.warrantId,
  agentId: AGENTS.treasury.agentId,
  agentRole: "treasury",
  rail: "airwallex_transfer",
  payeeId: "pay_licensor",
  amount: { currency: "EUR", cents: 5000 },
  category: "licence_fee",
  recurrence: "one_off",
  idempotencyKey,
  justification: "Invoice INV-1107: monthly data licence",
  createdAt: NOW.toISOString(),
});

describe("live config: optional airwallex block", () => {
  it("reads airwallex only when all three vars are present and non-empty", () => {
    const full = liveConfigFromEnv(
      baseMetalEnv({
        AIRWALLEX_BASE_URL: "https://api.sandbox.airwallex.com/",
        AIRWALLEX_CLIENT_ID: "cid_test_1",
        AIRWALLEX_API_KEY: "key_test_1",
      }),
    );
    expect(full.airwallex).toEqual({
      baseUrl: "https://api.sandbox.airwallex.com",
      clientId: "cid_test_1",
      apiKey: "key_test_1",
    });
    // Airwallex credentials must never be passed into the Metal CLI child environment.
    expect(full.cliEnv["AIRWALLEX_BASE_URL"]).toBeUndefined();
    expect(full.cliEnv["AIRWALLEX_CLIENT_ID"]).toBeUndefined();
    expect(full.cliEnv["AIRWALLEX_API_KEY"]).toBeUndefined();
  });

  it("reads nothing when any of the three Airwallex vars is missing or blank", () => {
    const baseline = liveConfigFromEnv(baseMetalEnv());
    expect(baseline.airwallex).toBeUndefined();
    expect("airwallex" in baseline).toBe(false);

    const cases: Record<string, string | undefined>[] = [
      { AIRWALLEX_BASE_URL: "https://api.sandbox.airwallex.com" },
      { AIRWALLEX_CLIENT_ID: "cid" },
      { AIRWALLEX_API_KEY: "key" },
      { AIRWALLEX_BASE_URL: "https://api.sandbox.airwallex.com", AIRWALLEX_CLIENT_ID: "cid" },
      { AIRWALLEX_BASE_URL: "https://api.sandbox.airwallex.com", AIRWALLEX_API_KEY: "key" },
      { AIRWALLEX_CLIENT_ID: "cid", AIRWALLEX_API_KEY: "key" },
      {
        AIRWALLEX_BASE_URL: "https://api.sandbox.airwallex.com",
        AIRWALLEX_CLIENT_ID: "cid",
        AIRWALLEX_API_KEY: "   ",
      },
      {
        AIRWALLEX_BASE_URL: "",
        AIRWALLEX_CLIENT_ID: "cid",
        AIRWALLEX_API_KEY: "key",
      },
    ];
    for (const partial of cases) {
      expect(airwallexConfigFromEnv(partial)).toBeUndefined();
      const cfg = liveConfigFromEnv(baseMetalEnv(partial));
      expect(cfg).toEqual(baseline);
      expect("airwallex" in cfg).toBe(false);
    }
  });
});

describe("live Airwallex wiring", () => {
  it("without the airwallex block, keeps AlwaysPaysRail and default warrant bodies", async () => {
    const cfg = liveConfigFromEnv(baseMetalEnv());
    const awx = await makeLiveAirwallex(cfg.airwallex);
    expect(awx.rail).toBeInstanceOf(AlwaysPaysRail);
    expect(awx.licensorRef).toBeUndefined();
    expect(bodies(NOW, undefined, awx.licensorRef)).toEqual(bodies(NOW));

    const world = makeWorld(NOW, {
      airwallex: { transfers: awx.rail, licensorRef: awx.licensorRef ?? "ben_licensor" },
    });
    const engine = createEngine({ scenario: "none", clock: () => NOW, world });
    const r = await engine.controller.submit(licenceProposal("live-mock-rail-1"));
    expect(r.execution).toMatchObject({
      status: "succeeded",
      railRef: "mock_live-mock-rail-1",
    });
  });

  it("with the airwallex block, returns AirwallexTransfers and a licence payment reaches PAID on the mock", async () => {
    const mock = await startAirwallexMock({
      balances: { USD: 60 },
      rates: { EURUSD },
    });
    try {
      const cfg = liveConfigFromEnv(
        baseMetalEnv({
          AIRWALLEX_BASE_URL: mock.url,
          AIRWALLEX_CLIENT_ID: "mock-client",
          AIRWALLEX_API_KEY: "mock-key",
        }),
      );
      const awx = await makeLiveAirwallex(cfg.airwallex);
      expect(awx.rail).toBeInstanceOf(AirwallexTransfers);
      expect(typeof awx.licensorRef).toBe("string");

      const world = makeWorld(NOW, {
        airwallex: { transfers: awx.rail, licensorRef: awx.licensorRef ?? "ben_licensor" },
      });
      expect(world.warrants.get(AGENTS.treasury.warrantId)?.payees[0]?.routingRef).toBe(
        awx.licensorRef,
      );

      const engine = createEngine({ scenario: "none", clock: () => NOW, world });
      const r = await engine.controller.submit(licenceProposal("live-awx-fee-1"));
      expect(r.execution?.status).toBe("pending");
      const transferId = r.execution?.railRef;
      expect(typeof transferId).toBe("string");

      const client = new AirwallexClient({
        baseUrl: mock.url,
        clientId: "mock-client",
        apiKey: "mock-key",
      });
      for (const next of ["PROCESSING", "SENT", "PAID"] as const) {
        await simulateTransfer(client, String(transferId), next);
      }
      const rec = await engine.controller.reconcile();
      expect(rec.confirmed).toEqual([r.execution?.reservationId]);
      expect(await world.rails.airwallex_transfer.getStatus("live-awx-fee-1")).toEqual({
        status: "succeeded",
        railRef: transferId,
        detail: "PAID",
      });
      expect(engine.controller.ledger.spentCents(AGENTS.treasury.warrantId)).toBe(5000);
    } finally {
      await mock.close();
    }
  });

  it("resolves the sandbox SWIFT beneficiary by nickname (reusing existing or creating once) and pays via SWIFT", async () => {
    const calls: { method: string; path: string; body?: unknown }[] = [];
    let existing: { id: string; nickname: string }[] = [];
    const fakeFetch: typeof fetch = (async (input, init) => {
      const u = new URL(typeof input === "string" ? input : input.toString());
      const method = init?.method ?? "GET";
      const body = typeof init?.body === "string" ? JSON.parse(init.body) : undefined;
      calls.push({ method, path: u.pathname + u.search, ...(body ? { body } : {}) });
      if (u.pathname.endsWith("/authentication/login")) {
        return new Response(JSON.stringify({ token: "tok_1" }), { status: 201 });
      }
      if (u.pathname.endsWith("/beneficiaries") && method === "GET") {
        return new Response(JSON.stringify({ items: existing }), { status: 200 });
      }
      if (u.pathname.endsWith("/beneficiaries/create")) {
        existing = [{ id: "ben_swift_created", nickname: LICENSOR_SWIFT.name }];
        return new Response(JSON.stringify({ id: "ben_swift_created" }), { status: 201 });
      }
      if (u.pathname.endsWith("/fx/conversions/create")) {
        return new Response(JSON.stringify({ conversion_id: "conv_1", status: "SETTLED" }), {
          status: 201,
        });
      }
      if (u.pathname.endsWith("/transfers/create")) {
        return new Response(JSON.stringify({ id: "tr_swift_1", status: "SCHEDULED" }), {
          status: 201,
        });
      }
      return new Response("{}", { status: 404 });
    }) as typeof fetch;

    const airwallex = {
      baseUrl: "https://api.sandbox.airwallex.com",
      clientId: "cid_swift",
      apiKey: "key_swift",
    };

    // First run: not found -> creates LICENSOR_SWIFT once.
    const first = await makeLiveAirwallex(airwallex, { fetch: fakeFetch });
    expect(first.licensorRef).toBe("ben_swift_created");
    expect(calls.some((c) => c.path === "/api/v1/beneficiaries/create")).toBe(true);

    // Second run: found by nickname -> does not create a second beneficiary.
    calls.length = 0;
    const second = await makeLiveAirwallex(airwallex, { fetch: fakeFetch });
    expect(second.licensorRef).toBe("ben_swift_created");
    expect(calls.some((c) => c.path === "/api/v1/beneficiaries/create")).toBe(false);

    // Executing a payout sends SWIFT with swift_charge_option SHARED after converting from USD.
    const exec = await second.rail.execute({
      rail: "airwallex_transfer",
      reservationId: "res_swift_1",
      idempotencyKey: "idem-swift-1",
      amount: { currency: "EUR", cents: 5000 },
      routingRef: String(second.licensorRef),
    });
    expect(exec).toEqual({ status: "pending", railRef: "tr_swift_1", detail: "SCHEDULED" });
    const createCall = calls.find((c) => c.path === "/api/v1/transfers/create");
    expect(createCall?.body).toMatchObject({
      beneficiary_id: "ben_swift_created",
      transfer_method: "SWIFT",
      swift_charge_option: "SHARED",
      transfer_currency: "EUR",
      source_currency: "EUR",
      transfer_amount: "50.00",
    });
  });

  it("never leaks secrets in mode labels, console output or thrown errors", async () => {
    const secretClientId = "cid_secret_sentinel_901";
    const secretApiKey = "key_secret_sentinel_902";
    const secretRpc = "https://rpc.testnet.invalid/rpc_secret_sentinel_903";
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => undefined);
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);
    try {
      const env = baseMetalEnv({
        METAL_RPC_URL: secretRpc,
        AIRWALLEX_BASE_URL: "https://api.sandbox.airwallex.com",
        AIRWALLEX_CLIENT_ID: secretClientId,
        AIRWALLEX_API_KEY: secretApiKey,
      });
      const withAwx = liveConfigFromEnv(env);
      const withoutAwx = liveConfigFromEnv(baseMetalEnv({ METAL_RPC_URL: secretRpc }));

      expect(liveModeLabel(undefined)).toBe("mock rails");
      expect(liveModeLabel(withoutAwx)).toBe("Metal testnet, Airwallex mock");
      expect(liveModeLabel(withAwx)).toBe("Metal testnet, Airwallex sandbox");

      // Missing Metal var error does not include Airwallex or RPC secrets.
      expect(() =>
        liveConfigFromEnv({
          METAL_RPC_URL: secretRpc,
          AIRWALLEX_BASE_URL: "https://api.sandbox.airwallex.com",
          AIRWALLEX_CLIENT_ID: secretClientId,
          AIRWALLEX_API_KEY: secretApiKey,
        }),
      ).toThrow(/METAL_HOME is required/);

      // Production or malformed URL error does not echo URL or credentials.
      await expect(
        makeLiveAirwallex({
          baseUrl: "https://api.airwallex.com",
          clientId: secretClientId,
          apiKey: secretApiKey,
        }),
      ).rejects.toThrow("Airwallex base URL must be the sandbox, never production");
      await expect(
        makeLiveAirwallex({
          baseUrl: `not-a-url/${secretApiKey}`,
          clientId: secretClientId,
          apiKey: secretApiKey,
        }),
      ).rejects.toThrow("Airwallex base URL is not a URL");

      // Failed login (401) does not include clientId or apiKey in the error message.
      const rejectLogin: typeof fetch = (() =>
        Promise.resolve(
          new Response(JSON.stringify({ code: "unauthorized", message: secretApiKey }), {
            status: 401,
          }),
        )) as typeof fetch;
      let caught = "";
      try {
        await makeLiveAirwallex(withAwx.airwallex, { fetch: rejectLogin });
      } catch (e) {
        caught = (e as Error).message;
      }
      expect(caught).toBe("airwallex login failed (401)");

      const printed = [...logSpy.mock.calls, ...errSpy.mock.calls].flat().join(" ");
      for (const s of [secretClientId, secretApiKey, secretRpc]) {
        expect(caught).not.toContain(s);
        expect(printed).not.toContain(s);
        expect(liveModeLabel(withAwx)).not.toContain(s);
      }
    } finally {
      logSpy.mockRestore();
      errSpy.mockRestore();
    }
  });
});
