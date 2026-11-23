import { describe as group, expect, it } from "vitest";
import type { LoggedEvent } from "./api.js";
import {
  agentsLine,
  approveLabel,
  benchLine,
  describe,
  foldRepeats,
  laneName,
  mandateName,
  money,
  namesOf,
  ownerLine,
  percentUsed,
  scenarioLabel,
  subjectOf,
  viewRows,
  warrantName,
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
      "Sourcing agent asked to pay 0.04 USDZ to upstream. Blocked by the rules in its warrant.",
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

  it("names treasury's three warrants by job and falls back to the role name", () => {
    expect(warrantName("wrt_treasury", "treasury")).toBe("Treasury · licence");
    expect(warrantName("wrt_treasury_sweep", "treasury")).toBe("Treasury · sweep");
    expect(warrantName("wrt_treasury_card", "treasury")).toBe("Treasury · card");
    expect(warrantName("wrt_sourcing", "sourcing")).toBe("Sourcing agent");
    expect(warrantName("wrt_support", "support")).toBe("Support agent");
    expect(warrantName(undefined, "treasury")).toBe("Treasury agent");
    expect(
      laneName({
        warrantId: "wrt_treasury",
        agentRole: "treasury",
        allowedRails: ["airwallex_transfer"],
      }),
    ).toBe("Treasury · licence");
    expect(
      laneName({
        warrantId: "wrt_treasury_sweep",
        agentRole: "treasury",
        allowedRails: ["metal_x402"],
      }),
    ).toBe("Treasury · sweep");
    expect(
      laneName({
        warrantId: "wrt_treasury_card",
        agentRole: "treasury",
        allowedRails: ["airwallex_card"],
      }),
    ).toBe("Treasury · card");
    expect(laneName({ agentRole: "treasury", allowedRails: ["airwallex_transfer"] })).toBe(
      "Treasury",
    );
    expect(laneName({ agentRole: "treasury", allowedRails: ["airwallex_card"] })).toBe(
      "Treasury card",
    );
    expect(laneName({ agentRole: "sourcing", allowedRails: [] })).toBe("Sourcing");
    expect(
      subjectOf({
        warrant: { warrantId: "wrt_treasury_sweep", role: "treasury" },
        amount: { currency: "USDZ", cents: 20 },
      }),
    ).toBe("0.20 USDZ from the Treasury · sweep");
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
    expect(benchLine(h)).toBe("141 of 152 attacks blocked · limits alone 98");
  });

  it("shows nothing when a number is missing", () => {
    expect(benchLine(undefined)).toBeNull();
    expect(benchLine({ attacks: 1, benign: 1, modes: {} })).toBeNull();
  });
});

group("store events: the warrant pass check and the dispute decision", () => {
  const ev = (event: LoggedEvent["event"]): LoggedEvent => ({ seq: 1, at, event });
  const tx = "0x" + "d".repeat(64);

  it("a pass that checks out: who signed it, the mandate, the cap", () => {
    const line = describe(
      ev({
        type: "pass_checked",
        ok: true,
        problems: [],
        url: "http://127.0.0.1:4021/query/fx-eurusd",
        amountCents: 5,
        buyer: {
          payer: "0x" + "c".repeat(40),
          ownerId: "own_customer",
          ownerKey: "1a2b3c4d5e6f7a8b",
          warrantId: "wrt_customer",
          mandateId: "0x6908b0a2e62a939f6c16f3e899e4757d46033213fc9e57c50cb41c642c096374",
          perPaymentCap: { currency: "USDZ", cents: 5 },
        },
      }),
    );
    expect(line.tone).toBe("ok");
    expect(line.text).toBe(
      "Store checked the buyer's warrant pass for /query/fx-eurusd: signed by the owner " +
        "own_customer (key 1a2b3c4d), mandate 0x6908b0a2..., cap 0.05 USDZ.",
    );
  });

  it("a refused pass says why, in the checker's words", () => {
    const line = describe(
      ev({
        type: "pass_checked",
        ok: false,
        problems: ["no warrant pass: nothing shows an owner authorized this"],
        url: "http://127.0.0.1:4021/query/btc-usd",
        amountCents: 5,
      }),
    );
    expect(line.tone).toBe("stop");
    expect(line.text).toBe(
      "Store refused a buyer's warrant pass for /query/btc-usd (with no readable pass). " +
        "Not served, not charged.",
    );
    expect(line.why).toBe("no warrant pass: nothing shows an owner authorized this");
  });

  it("a dispute: how many refunded and kept, each order's reason and settlement", () => {
    const line = describe(
      ev({
        type: "dispute_decided",
        disputeId: "dsp_1",
        claim: "wrong_data",
        customer: "0x" + "c".repeat(40),
        refund: { currency: "USDZ", cents: 5 },
        orders: [
          {
            orderId: "ord_1",
            reason: "data_was_wrong",
            refundCents: 5,
            verified: true,
            txHash: tx,
          },
          {
            orderId: "ord_2",
            reason: "data_was_correct",
            refundCents: 0,
            verified: true,
            txHash: tx,
          },
          { orderId: "ord_404", reason: "order_not_found", refundCents: 0, verified: false },
        ],
      }),
    );
    expect(line.text).toBe("Dispute dsp_1 (wrong data): 3 orders, refund 1, kept 2.");
    expect(line.why).toBe(
      "ord_1: refund 0.05 USDZ (data was wrong, on chain 0xdddddddd...); " +
        "ord_2: kept (data was correct, on chain 0xdddddddd...); " +
        "ord_404: kept (order not found)",
    );
  });
});

group("first-visit wording", () => {
  it("names scenarios and mandates in plain words, raw ids pass through", () => {
    expect(scenarioLabel("price_rise")).toBe("Supplier raises the price");
    expect(scenarioLabel("new_one")).toBe("new_one");
    expect(mandateName("sourcing.json")).toBe("Sourcing agent · v1");
    expect(mandateName("sourcing-v2.json")).toBe("Sourcing agent · v2");
    expect(mandateName("other.json")).toBe("other.json");
  });

  it("the owner's latest action, only when it came after the latest payment", () => {
    const ev = (seq: number, event: unknown) => ({ seq, at, event }) as LoggedEvent;
    const roleOf = (id: string) => (id === "wrt_sourcing" ? "sourcing" : undefined);
    const events = [
      ev(1, {
        type: "proposal",
        proposal: {
          proposalId: "p1",
          warrantId: "wrt_sourcing",
          amount: { currency: "USDZ", cents: 2 },
        },
        result: {},
      }),
      ev(2, { type: "approval_decided", proposalId: "p1", ok: true, decision: "approved" }),
      ev(3, { type: "approval_decided", proposalId: "bud_1", ok: true, decision: "approved" }),
      ev(4, {
        type: "budget_changed",
        proposalId: "bud_1",
        warrantId: "wrt_sourcing",
        fromVersion: 1,
        toVersion: 2,
      }),
    ];
    expect(ownerLine(events, roleOf, 1)).toBe("You signed new limits for the Sourcing agent.");
    expect(ownerLine(events.slice(0, 2), roleOf, 1)).toBe(
      "You approved 0.02 USDZ from the Sourcing agent.",
    );
    expect(ownerLine(events.slice(0, 3), roleOf, 1)).toBe("You approved new limits.");
    expect(ownerLine(events, roleOf, 4)).toBeNull();
    const stop = ev(5, {
      type: "kill_switch",
      result: {
        event: { reason: "owner pressed stop", at, revokedWarrantIds: ["wrt_sourcing"] },
        revokedMandates: [],
        problems: [],
        durationMs: 0,
      },
    });
    expect(ownerLine([...events, stop], roleOf, 4)).toBe(
      "You pressed STOP: every payment is refused.",
    );
  });

  it("revoked warrants read as agent names", () => {
    expect(agentsLine(["sourcing", "support", "treasury"])).toBe(
      "Sourcing, Support and Treasury agents",
    );
    expect(agentsLine(["support"])).toBe("Support agent");
    expect(agentsLine([])).toBe("");
  });
});

group("names in the feed, not ids", () => {
  const warrants = [
    {
      warrantId: "wrt_sourcing",
      agentRole: "sourcing",
      payees: [{ payeeId: "pay_upstream", displayName: "Upstream data provider" }],
    },
  ];
  const proposal = {
    proposalId: "prp_9",
    warrantId: "wrt_sourcing",
    agentId: "agt_sourcing",
    agentRole: "sourcing",
    rail: "metal_x402",
    payeeId: "pay_upstream",
    amount: { currency: "USDZ", cents: 2 },
    category: "data_purchase",
    recurrence: "one_off",
    idempotencyKey: "idem_00009",
    justification: "",
    createdAt: at,
  } as const;
  const budgetView = {
    proposalId: "bud_1793656132174",
    kind: "budget_change",
    warrant: { warrantId: "wrt_sourcing", version: 1, role: "sourcing" },
    proposedBy: "agt_treasury",
  };
  const events: LoggedEvent[] = [
    { seq: 1, at, event: { type: "proposal", proposal, result: { blockedBy: "rules" } } },
    {
      seq: 2,
      at,
      event: {
        type: "approval_requested",
        pending: {
          proposalId: "bud_1793656132174",
          view: budgetView,
          shownHash: "63385189bde8",
          reasons: ["budget change: always the owner's decision"],
          requestedAt: at,
        },
      },
    },
    {
      seq: 3,
      at,
      event: {
        type: "approval_decided",
        proposalId: "bud_1793656132174",
        ok: true,
        decision: "approved",
      },
    },
    {
      seq: 4,
      at,
      event: {
        type: "budget_changed",
        proposalId: "bud_1793656132174",
        warrantId: "wrt_sourcing",
        fromVersion: 1,
        toVersion: 2,
      },
    },
  ];
  const names = namesOf(events, warrants);
  const text = (i: number) => describe(events[i] as LoggedEvent, names).text;

  it("payees by name", () => {
    expect(text(0)).toBe(
      "Sourcing agent asked to pay 0.02 USDZ to Upstream data provider. Blocked by the rules in its warrant.",
    );
  });

  it("a budget change by what it asks, from request to signature", () => {
    expect(text(1)).toBe(
      "Needs your decision: new limits for the Sourcing agent (budget change: always the owner's decision)",
    );
    expect(text(2)).toBe("You approved new limits for the Sourcing agent.");
    expect(text(3)).toBe("You signed new limits for the Sourcing agent (v2).");
  });

  it("without names it still says something true", () => {
    expect(describe(events[3] as LoggedEvent).text).toBe(
      "You signed new limits for wrt_sourcing (v2).",
    );
  });
});

group("foldRepeats", () => {
  it("folds neighbours only, keeping the latest of each run", () => {
    const rows = [
      { k: "a", t: 1 },
      { k: "b", t: 2 },
      { k: "b", t: 3 },
      { k: "b", t: 4 },
      { k: "a", t: 5 },
    ];
    expect(foldRepeats(rows, (r) => r.k)).toEqual([
      { item: { k: "a", t: 1 }, n: 1 },
      { item: { k: "b", t: 4 }, n: 3 },
      { item: { k: "a", t: 5 }, n: 1 },
    ]);
    expect(foldRepeats([], String)).toEqual([]);
  });
});
