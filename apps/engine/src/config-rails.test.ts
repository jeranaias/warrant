import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { engineRailsMode, liveConfigFromEnv, railsMode } from "./config.js";
import { createEngine } from "./server.js";
import { makeWorld } from "./world.js";

/**
 * Plain `pnpm engine` stays on mock unless `RAILS_MODE=sandbox` is explicit. `pnpm live`
 * (`live: true`) opts into real rails when the testnet settings exist, and falls back to mock
 * naming any missing setting when incomplete.
 */
describe("engineRailsMode", () => {
  const home = mkdtempSync(join(tmpdir(), "metal-home-"));
  const bare = mkdtempSync(join(tmpdir(), "metal-home-bare-"));
  writeFileSync(
    join(home, "warrant-public.env"),
    "METAL_STORE_ADDRESS=0x1\nMETAL_UPSTREAM_ADDRESS=0x2\n",
  );
  afterAll(() => {
    rmSync(home, { recursive: true, force: true });
    rmSync(bare, { recursive: true, force: true });
  });
  const ready = { METAL_HOME: home, METAL_RPC_URL: "https://rpc.invalid/secret-token" };

  it("unset or auto: mock for plain pnpm engine, even when testnet settings are present", () => {
    expect(engineRailsMode({})).toEqual({ mode: "mock", why: "default (mock)" });
    expect(engineRailsMode(ready).mode).toBe("mock");
    expect(engineRailsMode({ ...ready, RAILS_MODE: "auto" }).mode).toBe("mock");
    expect(engineRailsMode({ ...ready, RAILS_MODE: "" }).mode).toBe("mock");
  });

  it("explicit RAILS_MODE=sandbox or mock: respected for plain engine", () => {
    expect(engineRailsMode({ RAILS_MODE: "sandbox" })).toEqual({
      mode: "sandbox",
      why: "RAILS_MODE=sandbox",
    });
    expect(engineRailsMode({ ...ready, RAILS_MODE: "sandbox" }).mode).toBe("sandbox");
    expect(engineRailsMode({ ...ready, RAILS_MODE: "mock" }).mode).toBe("mock");
    expect(() => engineRailsMode({ RAILS_MODE: "prod" })).toThrow(/mock, sandbox or auto/);
  });

  it("pnpm live with full settings: sandbox (from warrant-public.env or env vars)", () => {
    expect(engineRailsMode(ready, { live: true })).toEqual({
      mode: "sandbox",
      why: "testnet settings found (pnpm live)",
    });
    expect(engineRailsMode({ ...ready, RAILS_MODE: "auto" }, { live: true }).mode).toBe("sandbox");
    expect(engineRailsMode({ ...ready, RAILS_MODE: "" }, true).mode).toBe("sandbox");
    const inline = {
      METAL_HOME: bare,
      METAL_RPC_URL: "https://rpc.invalid/secret-token",
      METAL_STORE_ADDRESS: "0x1",
      METAL_UPSTREAM_ADDRESS: "0x2",
    };
    expect(engineRailsMode(inline, { live: true }).mode).toBe("sandbox");
    expect(liveConfigFromEnv(ready).business).toBe("0x1");
    expect(liveConfigFromEnv(ready).upstream).toBe("0x2");
    expect(engineRailsMode({ ...ready, RAILS_MODE: "mock" }, { live: true }).mode).toBe("mock");
  });

  it("pnpm live with missing settings: mock with missing names listed, never secret values", () => {
    expect(engineRailsMode({}, { live: true })).toEqual({
      mode: "mock",
      why: "no METAL_HOME, METAL_RPC_URL, METAL_STORE_ADDRESS, METAL_UPSTREAM_ADDRESS (RAILS_MODE=auto)",
    });
    const noAddresses = engineRailsMode({ ...ready, METAL_HOME: bare }, { live: true });
    expect(noAddresses).toEqual({
      mode: "mock",
      why: "no METAL_STORE_ADDRESS, METAL_UPSTREAM_ADDRESS (RAILS_MODE=auto)",
    });
    const noRpc = engineRailsMode(
      {
        METAL_HOME: home,
        AIRWALLEX_API_KEY: "awx_secret_value_123",
      },
      { live: true },
    );
    expect(noRpc).toEqual({
      mode: "mock",
      why: "no METAL_RPC_URL (RAILS_MODE=auto)",
    });
    const sandboxIncomplete = engineRailsMode(
      {
        RAILS_MODE: "sandbox",
        METAL_HOME: bare,
        METAL_RPC_URL: "https://rpc.invalid/secret-token",
        METAL_STORE_ADDRESS: "0x1",
      },
      { live: true },
    );
    expect(sandboxIncomplete).toEqual({
      mode: "mock",
      why: "no METAL_UPSTREAM_ADDRESS (RAILS_MODE=sandbox)",
    });
    for (const r of [noAddresses, noRpc, sandboxIncomplete]) {
      expect(r.why).not.toContain("rpc.invalid");
      expect(r.why).not.toContain("secret-token");
      expect(r.why).not.toContain("awx_secret_value_123");
      expect(r.why).not.toContain(home);
      expect(r.why).not.toContain(bare);
    }
  });

  it("the scenes keep railsMode: testnet only when RAILS_MODE=sandbox", () => {
    expect(railsMode(ready)).toBe("mock");
    expect(railsMode({ ...ready, RAILS_MODE: "auto" })).toBe("mock");
    expect(railsMode({ RAILS_MODE: "sandbox" })).toBe("sandbox");
  });

  it("plain engine on real rails starts with an empty scenario queue; mock preloads all", async () => {
    const mockEngine = createEngine();
    const sandboxEngine = createEngine({ world: { ...makeWorld(), mode: "sandbox" } });
    const queuedOf = async (app: ReturnType<typeof createEngine>["app"]) => {
      const s = app.listen(0, "127.0.0.1");
      await new Promise<void>((ok) => s.once("listening", () => ok()));
      const a = s.address();
      const port = typeof a === "object" && a ? a.port : 0;
      try {
        const r = await fetch(`http://127.0.0.1:${port}/health`);
        return ((await r.json()) as { queued: number }).queued;
      } finally {
        await new Promise<void>((ok) => s.close(() => ok()));
      }
    };
    expect(await queuedOf(mockEngine.app)).toBeGreaterThan(0);
    expect(await queuedOf(sandboxEngine.app)).toBe(0);
  });
});
