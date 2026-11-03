import { describe, expect, it } from "vitest";
import type { Names } from "./format.js";
import { outcomeLine, replayLines } from "./replay.js";
import type { Replay } from "./replay.js";

const usdz = (cents: number) => ({ currency: "USDZ" as const, cents });
const at = "2026-11-01T12:00:00Z";
const names: Names = {
  role: () => "sourcing",
  payee: (id) => (id === "pay_upstream" ? "Upstream data" : undefined),
  request: () => undefined,
};
const asked = {
  kind: "asked" as const,
  at,
  agentId: "agt_sourcing",
  agentRole: "sourcing",
  warrantId: "wrt_sourcing",
  payeeId: "pay_upstream",
  rail: "metal_x402",
  amount: usdz(2),
};

describe("replay wording", () => {
  it("paid: who asked whom for how much, all rules passed, money moved; ids only in ids", () => {
    const r: Replay = {
      proposalId: "prop_1",
      found: true,
      outcome: "paid",
      steps: [
        asked,
        {
          kind: "rules",
          at,
          pass: true,
          checks: [
            { rule: "payee_allowlist", pass: true, detail: "ok" },
            { rule: "per_payment_cap", pass: true, detail: "ok" },
          ],
        },
        { kind: "ledger", at, entry: "reserve", reservationId: "res_1", amount: usdz(2) },
        {
          kind: "ledger",
          at,
          entry: "confirm",
          reservationId: "res_1",
          amount: usdz(2),
          railRef: "0xtx",
          rail: { status: "succeeded", statusCheck: false },
        },
      ],
    };
    const lines = replayLines(r, names);
    expect(outcomeLine(r).text).toBe("Paid");
    expect(lines.map((l) => l.text)).toEqual([
      "Sourcing agent asked to pay 0.02 USDZ to Upstream data",
      "Rules: all 2 checks passed",
      "Funds held: 0.02 USDZ",
      "Money moved: 0.02 USDZ",
    ]);
    for (const l of lines) expect(l.text).not.toMatch(/prop_|res_|wrt_|0x/);
    expect(lines[0]?.ids).toContain("prop_1");
    expect(lines[3]?.ids).toBe("res_1 · 0xtx");
  });

  it("blocked by a rule: the failing rule in words, and which layer stopped it", () => {
    const r: Replay = {
      proposalId: "prop_2",
      found: true,
      outcome: "blocked",
      stoppedBy: "rules",
      steps: [
        { ...asked, amount: usdz(4) },
        {
          kind: "rules",
          at,
          pass: false,
          checks: [
            { rule: "payee_allowlist", pass: true, detail: "ok" },
            { rule: "per_payment_cap", pass: false, detail: "4 > 3" },
          ],
        },
        { kind: "purpose_skipped", at },
      ],
    };
    const lines = replayLines(r, names);
    expect(outcomeLine(r)).toEqual({ tone: "stop", text: "Blocked by the rules" });
    expect(lines[1]?.text).toBe("Rules: 1 of 2 failed");
    expect(lines[1]?.checks?.find((c) => !c.ok)).toMatchObject({
      label: "over the per-payment cap",
      detail: "4 > 3",
    });
  });

  it("held, denied; and a timeout settled by a status check", () => {
    const denied: Replay = {
      proposalId: "prop_3",
      found: true,
      outcome: "denied",
      stoppedBy: "owner",
      steps: [
        asked,
        { kind: "owner_asked", at, reasons: ["recurring bill"], shownHash: "ab".repeat(32) },
        { kind: "owner_decided", at, decision: "denied" },
      ],
    };
    const d = replayLines(denied, names);
    expect(outcomeLine(denied).text).toBe("Denied by you");
    expect(d.map((l) => l.text).slice(1)).toEqual(["Held for you", "You denied"]);
    expect(d[1]?.ids).toMatch(/^shown /);

    const late: Replay = {
      proposalId: "prop_4",
      found: true,
      outcome: "paid",
      steps: [
        { kind: "ledger", at, entry: "unconfirmed", reservationId: "res_4", amount: usdz(2) },
        {
          kind: "ledger",
          at,
          entry: "confirm",
          reservationId: "res_4",
          amount: usdz(2),
          rail: { status: "succeeded", detail: "status check", statusCheck: true },
        },
      ],
    };
    expect(replayLines(late, names).map((l) => l.text)).toEqual([
      "Rail answer unknown: the funds stay held until a status check",
      "Money moved: 0.02 USDZ, found by a status check",
    ]);
  });
});
