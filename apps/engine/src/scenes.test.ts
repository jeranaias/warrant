import { describe, expect, it } from "vitest";
import { priceRiseScene } from "./scenes.js";

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
});
