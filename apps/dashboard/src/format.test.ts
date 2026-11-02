import { describe as group, expect, it } from "vitest";
import type { LoggedEvent } from "./api.js";
import {
  approveLabel,
  benchLine,
  describe,
  laneName,
  money,
  percentUsed,
  viewRows,
  whyOf,
} from "./format.js";

const at = "2026-10-30T12:00:00.000Z";

group("money", () => {
  it("formats integer cents without floats", () => {
    expect(money({ currency: "USDZ", cents: 4 })).toBe("0.04 USDZ");
    expect(money({ currency: "EUR", cents: 123456 })).toBe("EUR 1234.56");
    expect(money({ currency: "USD", cents: -5 })).toBe("USD -0.05");
    expect(money(undefined)).toBe("-");
  });
});

group("percentUsed", () => {
  it("is inclusive at the cap and never over 100", () => {
    expect(percentUsed(0, 1000)).toBe(0);
    expect(percentUsed(1000, 1000)).toBe(100);
    expect(percentUsed(2000, 1000)).toBe(100);
    expect(percentUsed(0, 0)).toBe(0);
  });
});

group("describe", () => {
  const proposal = {
    proposalId: "prp_1",
    warrantId: "wrt_sourcing",
    agentId: "agt_sourcing",
    agentRole: "sourcing",
    rail: "metal_x402",
    payeeId: "pay_upstream",
    amount: { currency: "USDZ", cents: 4 },
    category: "data_purchase",
    recurrence: "one_off",
    idempotencyKey: "idem_00001",
    justification: "",
    createdAt: at,
  } as const;

  it("says who asked, how much, and what control did", () => {
    const blocked: LoggedEvent = {
      seq: 1,
      at,
      event: { type: "proposal", proposal, result: { blockedBy: "rules" } },
    };
    expect(describe(blocked)).toMatchObject({ seq: 1, tone: "stop" });
    expect(describe(blocked).text).toBe(
      "Sourcing agent asked to pay 0.04 USDZ to pay_upstream. Blocked by the rules in its warrant.",
    );

    const waiting: LoggedEvent = {
      seq: 2,
      at,
      event: {
        type: "proposal",
        proposal,
        result: { decision: { outcome: "needs_owner_approval" } },
      },
    };
    expect(describe(waiting).tone).toBe("wait");
  });

  it("reports the stop with its timing", () => {
    const e: LoggedEvent = {
      seq: 3,
      at,
      event: {
        type: "kill_switch",
        result: {
          event: { reason: "x", at, revokedWarrantIds: [] },
          revokedMandates: [],
          problems: [],
          durationMs: 12,
        },
      },
    };
    expect(describe(e).text).toContain("12 ms");
  });

  it("the stop says how many cards it froze", () => {
    const e: LoggedEvent = {
      seq: 4,
      at,
      event: {
        type: "kill_switch",
        result: {
          event: { reason: "x", at, revokedWarrantIds: [], frozenCardIds: ["c1"] },
          revokedMandates: [],
          problems: [],
          durationMs: 7,
        },
      },
    };
    expect(describe(e).text).toBe(
      "STOP pressed. Every payment refused, mandates revoked, 1 card frozen (took 7 ms).",
    );
  });

  it("a card-only warrant gets its own lane name", () => {
    expect(laneName({ agentRole: "treasury", allowedRails: ["airwallex_transfer"] })).toBe(
      "Treasury",
    );
    expect(laneName({ agentRole: "treasury", allowedRails: ["airwallex_card"] })).toBe(
      "Treasury card",
    );
    expect(laneName({ agentRole: "sourcing", allowedRails: [] })).toBe("Sourcing");
  });

  it("flags a decision that did not count", () => {
    const e: LoggedEvent = {
      seq: 4,
      at,
      event: { type: "approval_decided", proposalId: "prp_1", ok: false },
    };
    expect(describe(e).tone).toBe("stop");
  });
});

group("viewRows", () => {
  it("shows every field of the view, nested ones flattened", () => {
    const rows = viewRows({
      proposalId: "prp_1",
      agent: { agentId: "agt_sourcing", role: "sourcing" },
      payee: { refundOfOrderId: null },
      amount: { currency: "USDZ", cents: 250 },
      extra: "kept",
    });
    expect(rows.map((r) => r.key)).toEqual([
      "proposalId",
      "agent.agentId",
      "agent.role",
      "payee.refundOfOrderId",
      "amount",
      "extra",
    ]);
    expect(rows.find((r) => r.key === "amount")?.value).toBe("2.50 USDZ");
    expect(rows.find((r) => r.key === "payee.refundOfOrderId")?.value).toBe("-");
    expect(rows.find((r) => r.key === "extra")?.label).toBe("extra");
  });
});

group("reasons and the approve button", () => {
  it("a rules block shows the failed rule's own words, never the agent's", () => {
    const e = {
      type: "proposal" as const,
      proposal: {
        agentRole: "sourcing",
        payeeId: "pay_upstream",
        amount: { currency: "USDZ" as const, cents: 4 },
      },
      result: {
        blockedBy: "rules" as const,
        decision: {
          outcome: "blocked" as const,
          rules: {
            checks: [
              { rule: "payee_allowlist", pass: true, detail: "on the warrant" },
              { rule: "per_payment_cap", pass: false, detail: "4 cents is over the 3-cent cap" },
            ],
          },
          purpose: null,
        },
      },
    } as unknown as Parameters<typeof whyOf>[0];
    expect(whyOf(e)).toBe("4 cents is over the 3-cent cap");
  });

  it("the approve button repeats the amount", () => {
    expect(approveLabel({ amount: { currency: "EUR", cents: 5000 } })).toBe("Approve EUR 50.00");
    expect(approveLabel({ kind: "budget_change" })).toBe("Approve");
  });
});

group("benchLine", () => {
  it("states the committed benchmark numbers, facts only", () => {
    const h = {
      attacks: 152,
      benign: 31,
      modes: {
        unprotected: { attacksBlocked: 0, falseBlocks: 0 },
        limits_only: { attacksBlocked: 98, falseBlocks: 0 },
        warrant: { attacksBlocked: 141, falseBlocks: 1 },
      },
    };
    expect(benchLine(h)).toBe(
      "Benchmark: blocks 141 of 152 attacks · limits alone 98 · 1 of 31 normal payments held",
    );
  });

  it("shows nothing when a number is missing", () => {
    expect(benchLine(undefined)).toBeNull();
    expect(benchLine({ attacks: 1, benign: 1, modes: {} })).toBeNull();
  });
});
