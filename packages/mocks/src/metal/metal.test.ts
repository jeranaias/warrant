import { describe, expect, it } from "vitest";
import {
  MockMetalChain,
  UPSTREAM_PAY_TO,
  UPSTREAM_URL,
  addUpstream,
  mockAddress,
} from "./index.js";

const PRINCIPAL = mockAddress("owner");

function setup() {
  const chain = new MockMetalChain(() => new Date("2026-11-01T12:00:00Z"));
  chain.fund(PRINCIPAL, 100);
  const upstream = addUpstream(chain, 2);
  chain.addMandate({
    credential: "sourcing.json",
    principal: PRINCIPAL,
    capCents: 3,
    budgetCents: 10,
    payees: [UPSTREAM_PAY_TO],
    expiresAt: new Date("2026-11-20T00:00:00Z"),
  });
  const pay = () => chain.runner()(["pay", UPSTREAM_URL, "--mandate", "home/sourcing.json"], 1000);
  return { chain, upstream, pay };
}

describe("mock Metal chain", () => {
  it("pays the upstream at its price and prints the CLI's key/value lines", async () => {
    const { chain, pay } = setup();
    const r = await pay();
    expect(r.code).toBe(0);
    expect(r.stdout).toMatch(/^status 200$/m);
    expect(r.stdout).toMatch(/^amount 0\.02 \*USDZ$/m);
    expect(chain.mandate("sourcing.json").spentCents).toBe(2);
  });

  it("refuses over the cap, over the budget, and once revoked; nothing moves", async () => {
    const { chain, upstream, pay } = setup();
    upstream.setPrice(4);
    expect((await pay()).stderr).toMatch(/payment refused: mandate_cap_exceeded/);
    upstream.setPrice(3);
    for (let k = 0; k < 3; k++) await pay(); // 9 of 10 spent
    expect((await pay()).stderr).toMatch(/mandate_budget_spent/);
    chain.revokeMandate("sourcing.json");
    expect((await pay()).stderr).toMatch(/mandate_revoked/);
    expect(chain.refusals.map((r) => r.reason)).toEqual([
      "mandate_cap_exceeded",
      "mandate_budget_spent",
      "mandate_revoked",
    ]);
    expect(chain.mandate("sourcing.json").spentCents).toBe(9);
  });

  it("replace carries spend forward and revokes the old credential", async () => {
    const { chain, pay } = setup();
    await pay();
    const next = chain.replaceMandate("sourcing.json", {
      credential: "sourcing-v2.json",
      principal: PRINCIPAL,
      capCents: 5,
      budgetCents: 50,
      expiresAt: new Date("2026-11-20T00:00:00Z"),
    });
    expect(next.spentCents).toBe(2);
    expect((await pay()).stderr).toMatch(/mandate_revoked/);
  });
});
