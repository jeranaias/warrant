import { describe, expect, it } from "vitest";
import { limitChangeScene, priceRiseScene } from "./scenes.js";

describe("price rise scene (Kit 11: 2 cents, then 4)", () => {
  it("pays at 2, then refuses 4 in our rules, at the rail, and on chain", async () => {
    const steps = await priceRiseScene(() => new Date("2026-11-01T12:00:00Z"));
    expect(steps.map((s) => s.moneyMoved)).toEqual([true, true, false, false, false]);
    expect(steps[0]?.outcome).toBe("succeeded");
    expect(steps[1]?.outcome).toBe("succeeded");
    expect(steps[2]?.outcome).toBe("rules (per_payment_cap)");
    expect(steps[3]?.outcome).toMatch(/^rail \(price changed: offered 4, approved 2/);
    expect(steps[4]?.outcome).toBe("chain refused: mandate_cap_exceeded");
  });

  it("then the owner approves a 4-cent cap: mandate replaced, 4 cents pays, old credential refused", async () => {
    const steps = (await limitChangeScene(() => new Date("2026-11-01T12:00:00Z"))).slice(5);
    expect(steps.map((s) => s.outcome)).toEqual([
      "waiting for the owner",
      "mandate replaced, warrant v2 signed",
      "owner approved, succeeded",
      "chain refused: mandate_revoked",
    ]);
    expect(steps.map((s) => s.moneyMoved)).toEqual([false, false, true, false]);
  });
});
