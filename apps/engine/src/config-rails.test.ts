import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { engineRailsMode, railsMode } from "./config.js";

/** `pnpm engine` picks real rails only when their settings exist; an explicit choice wins. */
describe("engineRailsMode", () => {
  const home = mkdtempSync(join(tmpdir(), "metal-home-"));
  const bare = mkdtempSync(join(tmpdir(), "metal-home-bare-"));
  writeFileSync(join(home, "warrant-public.env"), "METAL_STORE_ADDRESS=0x1\n");
  afterAll(() => {
    rmSync(home, { recursive: true, force: true });
    rmSync(bare, { recursive: true, force: true });
  });
  const ready = { METAL_HOME: home, METAL_RPC_URL: "https://rpc.invalid" };

  it("unset or auto: testnet when METAL_HOME, METAL_RPC_URL and warrant-public.env are there", () => {
    expect(engineRailsMode(ready).mode).toBe("sandbox");
    expect(engineRailsMode({ ...ready, RAILS_MODE: "auto" }).mode).toBe("sandbox");
    expect(engineRailsMode({ ...ready, RAILS_MODE: "" }).mode).toBe("sandbox");
  });

  it("anything missing: mock, and it says what is missing (never the URL)", () => {
    expect(engineRailsMode({})).toEqual({
      mode: "mock",
      why: "no METAL_HOME, METAL_RPC_URL (RAILS_MODE=auto)",
    });
    const noFile = engineRailsMode({ ...ready, METAL_HOME: bare });
    expect(noFile.mode).toBe("mock");
    expect(noFile.why).toMatch(/warrant-public\.env/);
    expect(engineRailsMode({ METAL_HOME: home }).why).not.toMatch(/rpc\.invalid/);
  });

  it("an explicit RAILS_MODE always wins", () => {
    expect(engineRailsMode({ ...ready, RAILS_MODE: "mock" }).mode).toBe("mock");
    expect(engineRailsMode({ RAILS_MODE: "sandbox" }).mode).toBe("sandbox");
    expect(() => engineRailsMode({ RAILS_MODE: "prod" })).toThrow(/mock, sandbox or auto/);
  });

  it("the scenes keep the old rule: testnet only when asked", () => {
    expect(railsMode(ready)).toBe("mock");
    expect(railsMode({ ...ready, RAILS_MODE: "auto" })).toBe("mock");
    expect(railsMode({ RAILS_MODE: "sandbox" })).toBe("sandbox");
  });
});
