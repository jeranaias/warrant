import { describe as group, expect, it } from "vitest";
import type { LoggedEvent } from "./api.js";
import { describe, money, percentUsed, viewRows } from "./format.js";

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
