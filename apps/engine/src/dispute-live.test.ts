import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { CliRunner } from "@warrant/rails";
import { customerConfigFromEnv, liveConfigFromEnv } from "./config.js";
import type { CustomerBuyer } from "./customer.js";
import { liveDisputeScene } from "./dispute-live.js";
import type { LiveWorld } from "./live.js";
import { createEngine } from "./server.js";
import { recordingRunner } from "./world.js";

const at = () => new Date("2026-11-02T12:00:00Z");

/** The live scene's steps over the mock world: its stored orders stand in for the store's. */
function setup(paid: (string | undefined)[]) {
  const engine = createEngine({ scenario: "none", clock: at });
  const bad = new Set<string>();
  const world = {
    ...engine.world,
    badBatches: bad,
    markBatchBad: (b: string) => void bad.add(b),
  } as unknown as LiveWorld;
  engine.world.badBatches = bad;
  const txs = paid.map((id) => (id ? engine.world.orders().get(id)?.txHash : undefined));
  let n = 0;
  const buyer: CustomerBuyer = {
    address: "0x" + "c".repeat(40),
    mandateId: "0x" + "6".repeat(64),
    buy: () => {
      const tx = txs[n++];
      return Promise.resolve(tx ? { outcome: "paid", tx } : { outcome: "failed: refused" });
    },
  };
  return { engine, world, buyer, bad };
}

describe("live dispute scene (testnet steps, on the mock world)", () => {
  it("buys two, marks the first's batch bad, then refunds only that one", async () => {
    const { engine, world, buyer, bad } = setup(["ord_1", "ord_2"]);
    const steps = await liveDisputeScene(at, engine, world, buyer);
    expect(bad).toEqual(new Set(["bat_stale"]));
    expect(steps.map((s) => [s.step, s.outcome, s.moneyMoved])).toEqual([
      ["customer's agent buys fx-eurusd", "paid, store kept signed order ord_1", true],
      ["customer's agent buys btc-usd", "paid, store kept signed order ord_2", true],
      ["store: batch bat_stale was stale", "orders served from it are refundable", false],
      [
        "customer: the data was wrong",
        "ord_1 refund 5c (data_was_wrong); ord_2 no refund (data_was_correct)",
        false,
      ],
      ["support refunds ord_1 (mandate pull)", "succeeded", true],
      [
        "customer asks again, adds ord_404",
        "ord_1 no refund (already_refunded); ord_404 no refund (order_not_found)",
        false,
      ],
      ["support tries to refund ord_1 again", "rules (refund_matches_order)", false],
      [
        "customer: my agent never agreed",
        "ord_2 no refund (owner_authorized): 11 of 11 checks hold",
        false,
      ],
    ]);
    // Every payment carries its transaction; the dispute lines link each order's settlement.
    expect(steps.filter((s) => s.moneyMoved).every((s) => /^0x/.test(s.tx ?? ""))).toBe(true);
    expect(steps[3]?.notes?.[0]).toMatch(/^ord_1: .*https:\/\/testnet\.metalntwx\.com\/tx\/0x/);
  });

  it("stops before any dispute when a purchase does not settle", async () => {
    const { engine, world, buyer, bad } = setup(["ord_1", undefined]);
    const steps = await liveDisputeScene(at, engine, world, buyer);
    expect(steps.map((s) => s.outcome)).toEqual([
      "paid, store kept signed order ord_1",
      "failed: refused",
      "the purchase did not settle",
    ]);
    expect(bad.size).toBe(0);
    expect(engine.disputes.size).toBe(0);
  });
});

describe("live dispute setup", () => {
  const home = mkdtempSync(join(tmpdir(), "metal-home-"));
  const env = (more: Record<string, string> = {}) => ({
    METAL_HOME: home,
    METAL_RPC_URL: "http://rpc.invalid",
    METAL_STORE_ADDRESS: "0x" + "5".repeat(40),
    METAL_UPSTREAM_ADDRESS: "0x" + "b".repeat(40),
    ...more,
  });

  it("says what is missing: METAL_HOME, the owner key, the customer's address and credential", () => {
    expect(() => liveConfigFromEnv({})).toThrow(/METAL_HOME is required/);
    const missing = liveConfigFromEnv(env({ METAL_HOME: join(home, "nope") }));
    expect(() => customerConfigFromEnv(missing, {})).toThrow(/METAL_HOME does not exist/);
    const cfg = liveConfigFromEnv(env());
    expect(() => customerConfigFromEnv(cfg, {})).toThrow(/no business-owner\.json/);
    writeFileSync(join(home, "business-owner.json"), "{}");
    expect(() => customerConfigFromEnv(cfg, {})).toThrow(/METAL_CUSTOMER_ADDRESS is required/);
    const addr = { METAL_CUSTOMER_ADDRESS: "0x" + "c".repeat(40) };
    expect(() => customerConfigFromEnv(cfg, addr)).toThrow(/customer-agent\.json is not in/);
    expect(() =>
      customerConfigFromEnv(cfg, { ...addr, METAL_CUSTOMER_CREDENTIAL: "../x.json" }),
    ).toThrow(/plain file name/);
    writeFileSync(join(home, "customer-agent.json"), "{}");
    expect(customerConfigFromEnv(cfg, addr)).toEqual({
      address: addr.METAL_CUSTOMER_ADDRESS,
      credential: "customer-agent.json",
    });
  });
});

describe("recordingRunner", () => {
  it("notes settled pays and refunds (mandate pull) once each, and nothing refused", async () => {
    const tx = "0x" + "1".repeat(64);
    const out: Record<string, { code: number; stdout: string }> = {
      pay: { code: 0, stdout: `status 200\ntransaction ${tx}\n` },
      pull: { code: 0, stdout: `outcome paid\ntransaction ${"0x" + "2".repeat(64)}\n` },
      refused: { code: 1, stdout: "outcome refused mandate_cap_exceeded\n" },
    };
    const fake: CliRunner = (args) => {
      const k = args[0] === "pay" ? "pay" : args.includes("--refused") ? "refused" : "pull";
      const r = out[k] ?? { code: 1, stdout: "" };
      return Promise.resolve({ ...r, stderr: "", timedOut: false });
    };
    const settled: string[] = [];
    const run = recordingRunner(fake, settled);
    await run(["pay", "http://127.0.0.1:4021/query/fx-eurusd"], 1);
    await run(["mandate", "pull", "--payment-id", "p1"], 1);
    await run(["mandate", "pull", "--payment-id", "p1"], 1);
    await run(["mandate", "pull", "--refused"], 1);
    expect(settled).toEqual([tx, "0x" + "2".repeat(64)]);
  });
});
