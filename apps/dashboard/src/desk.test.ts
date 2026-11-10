import { describe, expect, it } from "vitest";
import type { LoggedEvent, PendingApproval, WarrantRow } from "./api.js";
import {
  askGroups,
  blockedKinds,
  deskRows,
  filterCounts,
  filterRows,
  paySentence,
  payeeName,
} from "./desk.js";
import type { PayRow } from "./desk.js";
import { OTHER, passesOf } from "./flow.js";
import type { Pass } from "./flow.js";
import type { SellerMoment } from "./seller.js";

const at = "2026-11-03T12:00:00.000Z";
const usdz = (cents: number) => ({ currency: "USDZ" as const, cents });
const pass = (seq: number, over: Partial<Pass> = {}): Pass => ({
  seq,
  proposalId: `prop_${seq}`,
  at,
  warrantId: "wrt_sourcing",
  payee: "pay_upstream",
  fate: "paid",
  amount: usdz(2),
  ...over,
});
const moment = (seq: number): SellerMoment => ({
  seq,
  at,
  kind: "pass",
  ok: true,
  title: "Pass checked",
  summary: "",
  rows: [],
});
const nameOf = (id: string) => (id === "wrt_sourcing" ? "Sourcing agent" : "Support agent");
const payeeOf = (id: string) => (id === "pay_upstream" ? "Upstream data provider" : id);
const rows = (passes: Pass[], moments: SellerMoment[] = []) =>
  deskRows(passes, moments, nameOf, payeeOf);

describe("deskRows", () => {
  it("lists newest first and leaves out what is still waiting", () => {
    const r = rows([pass(1), pass(2, { fate: "asked" }), pass(3, { amount: usdz(3) })]);
    expect(r.map((x) => x.seq)).toEqual([3, 1]);
  });

  it("folds alike payments in a row and keeps the latest", () => {
    const flood = Array.from({ length: 21 }, (_, i) =>
      pass(i + 1, { fate: "blocked", reason: "repeat of a recent payment" }),
    );
    const [only, ...rest] = rows(flood);
    expect(rest).toEqual([]);
    expect(only).toMatchObject({ kind: "pay", n: 21, seq: 21, proposalId: "prop_21" });
  });

  it("does not fold across a different reason, payee, amount or a store moment", () => {
    const r = rows(
      [
        pass(1),
        pass(2, { fate: "blocked", reason: "over the per-payment cap" }),
        pass(3, { fate: "blocked", reason: "payee not on the warrant" }),
        pass(5),
        pass(6),
      ],
      [moment(4)],
    );
    expect(r.map((x) => x.seq)).toEqual([6, 4, 3, 2, 1]);
    expect(r[0]).toMatchObject({ n: 2 });
    expect(r[1]?.kind).toBe("store");
  });
});

describe("filters", () => {
  const r = rows(
    [pass(1), pass(2), pass(3, { fate: "blocked", reason: "over the per-payment cap" })],
    [moment(4)],
  );

  it("count every payment in a folded row", () => {
    expect(filterCounts(r)).toEqual({ all: 4, paid: 2, blocked: 1, store: 1 });
  });

  it("keep only the rows asked for", () => {
    expect(filterRows(r, "blocked").map((x) => x.seq)).toEqual([3]);
    expect(filterRows(r, "store").map((x) => x.seq)).toEqual([4]);
    expect(filterRows(r, "all")).toHaveLength(3);
  });

  it("counts distinct (agent, payee, reason) kinds among blocked rows", () => {
    const flood = rows([
      pass(1, { fate: "blocked", reason: "over the per-payment cap" }),
      pass(2, { fate: "blocked", reason: "repeat of a recent payment" }),
      pass(3, { fate: "blocked", reason: "repeat of a recent payment" }),
      pass(4),
      pass(5, { fate: "blocked", reason: "over the per-payment cap" }),
      pass(6, { warrantId: "wrt_support", fate: "blocked", reason: "over the per-payment cap" }),
    ]);
    expect(filterCounts(flood).blocked).toBe(5);
    expect(blockedKinds(flood)).toBe(3);
  });
});

describe("paySentence", () => {
  const [paid] = rows([pass(1)]) as PayRow[];
  const [blocked] = rows([
    pass(1, { fate: "blocked", reason: "over the per-payment cap", amount: usdz(4) }),
    pass(2, { fate: "blocked", reason: "over the per-payment cap", amount: usdz(4) }),
  ]) as PayRow[];

  it("says who paid whom and how much", () => {
    expect(paySentence(paid as PayRow)).toBe(
      "Sourcing agent paid 0.02 USDZ to Upstream data provider.",
    );
  });

  it("says a blocked payment was blocked, why, and how many times", () => {
    expect(paySentence(blocked as PayRow)).toBe(
      "Sourcing agent asked to pay 0.04 USDZ to Upstream data provider, 2 times. Blocked: over the per-payment cap.",
    );
  });

  it("shows a pending transfer as sent (not paid) until a later execution for the reservation succeeds", () => {
    const warrants: WarrantRow[] = [
      {
        warrantId: "wrt_treasury",
        version: 1,
        agentId: "agt_treasury",
        agentRole: "treasury",
        purpose: "",
        allowedRails: ["airwallex"],
        payees: [
          {
            payeeId: "pay_licensor_eur",
            displayName: "Data licensor (EUR)",
            rail: "airwallex",
            currency: "EUR",
          },
        ],
        perPaymentCap: { currency: "EUR", cents: 6_000 },
        totalBudget: { currency: "EUR", cents: 15_000 },
        spentCents: 0,
      },
    ];
    const events: LoggedEvent[] = [
      {
        seq: 1,
        at,
        event: {
          type: "execution",
          proposalId: "prop_lic_1",
          execution: {
            reservationId: "res_lic_1",
            status: "pending",
            detail: "SCHEDULED",
          },
        },
      },
      {
        seq: 2,
        at,
        event: {
          type: "proposal",
          proposal: {
            proposalId: "prop_lic_1",
            warrantId: "wrt_treasury",
            payeeId: "pay_licensor_eur",
            amount: { currency: "EUR", cents: 5_000 },
            rail: "airwallex_transfer",
          },
          result: {
            decision: { outcome: "execute" },
            execution: {
              reservationId: "res_lic_1",
              status: "pending",
              detail: "SCHEDULED",
            },
          },
        },
      },
    ];
    const treasuryName = (id: string) =>
      id === "wrt_treasury" ? "Treasury · licence" : nameOf(id);
    const licensorPayee = (id: string) =>
      id === "pay_licensor_eur" ? "Data licensor (EUR)" : payeeOf(id);

    const pendingRows = deskRows(passesOf(events, warrants), [], treasuryName, licensorPayee);
    const [pendingRow] = pendingRows as PayRow[];
    expect(pendingRow?.fate).toBe("pending");
    expect(pendingRow?.fate).not.toBe("paid");
    expect(filterCounts(pendingRows)).toEqual({ all: 1, paid: 0, blocked: 0, store: 0 });
    expect(filterRows(pendingRows, "paid")).toEqual([]);
    expect(paySentence(pendingRow as PayRow)).toBe(
      "Treasury · licence sent EUR 50.00 to Data licensor (EUR). Scheduled.",
    );

    const settledEvents: LoggedEvent[] = [
      ...events,
      {
        seq: 3,
        at,
        event: {
          type: "execution",
          proposalId: "prop_lic_1",
          execution: {
            reservationId: "res_lic_1",
            status: "succeeded",
            detail: "status check",
          },
        },
      },
    ];
    const paidRows = deskRows(passesOf(settledEvents, warrants), [], treasuryName, licensorPayee);
    const [paidRow] = paidRows as PayRow[];
    expect(paidRow?.fate).toBe("paid");
    expect(filterCounts(paidRows)).toEqual({ all: 1, paid: 1, blocked: 0, store: 0 });
    expect(filterRows(paidRows, "paid")).toHaveLength(1);
    expect(paySentence(paidRow as PayRow)).toBe(
      "Treasury · licence paid EUR 50.00 to Data licensor (EUR).",
    );
  });
});

describe("askGroups", () => {
  const ask = (id: string, cents: number, reasons = ["second licence bill this month"]) =>
    ({
      proposalId: id,
      shownHash: `h_${id}`,
      reasons,
      requestedAt: at,
      view: {
        kind: "payment",
        warrant: { role: "treasury" },
        payee: { displayName: "Licensor GmbH" },
        amount: { currency: "EUR", cents },
      },
    }) satisfies PendingApproval;

  it("groups alike requests and keeps each one's own hash", () => {
    const g = askGroups([ask("a", 5000), ask("b", 5000), ask("c", 7000)]);
    expect(g).toHaveLength(2);
    expect(g[0]?.items.map((a) => a.shownHash)).toEqual(["h_a", "h_b"]);
    expect(g[0]).toMatchObject({ title: "Treasury agent → Licensor GmbH", amount: "EUR 50.00" });
    expect(g[0]?.why).toBe("second licence bill this month");
  });

  it("keeps requests apart when control gave different reasons", () => {
    const g = askGroups([ask("a", 5000), ask("b", 5000, ["large transfer"])]);
    expect(g).toHaveLength(2);
  });

  it("names a budget change and who asked for it", () => {
    const budget = {
      ...ask("x", 0),
      view: { kind: "budget_change", warrant: { role: "sourcing" }, proposedBy: "agt_treasury" },
    };
    const [g] = askGroups([budget], (id) => (id === "agt_treasury" ? "treasury" : undefined));
    expect(g).toMatchObject({
      title: "Treasury agent asks for new limits for the sourcing agent",
      amount: "new limits",
    });
  });
});

describe("payeeName", () => {
  const wrtTreasury: WarrantRow = {
    warrantId: "wrt_treasury",
    version: 1,
    agentId: "agt_treasury",
    agentRole: "treasury",
    purpose: "",
    allowedRails: ["airwallex"],
    payees: [
      {
        payeeId: "pay_licensor_eur",
        displayName: "Data licensor (EUR)",
        rail: "airwallex",
        currency: "EUR",
      },
    ],
    perPaymentCap: { currency: "EUR", cents: 6_000 },
    totalBudget: { currency: "EUR", cents: 15_000 },
    spentCents: 0,
  };
  const wrtSweep: WarrantRow = {
    warrantId: "wrt_treasury_sweep",
    version: 1,
    agentId: "agt_treasury",
    agentRole: "treasury",
    purpose: "",
    allowedRails: ["metal_x402"],
    payees: [
      {
        payeeId: "pay_treasury",
        displayName: "Our treasury (to Airwallex)",
        rail: "metal_x402",
        currency: "USDZ",
      },
    ],
    perPaymentCap: usdz(50),
    totalBudget: usdz(50),
    spentCents: 0,
  };

  it("names a payee from any warrant in the world that lists it, even when proposed under another warrant", () => {
    const warrants = [wrtTreasury, wrtSweep];
    const events: LoggedEvent[] = [
      {
        seq: 1,
        at,
        event: {
          type: "proposal",
          proposal: {
            proposalId: "prop_sweep_1",
            warrantId: "wrt_treasury",
            payeeId: "pay_treasury",
            amount: usdz(15),
            rail: "metal_x402",
            category: "treasury_sweep",
          },
          result: {
            decision: {
              outcome: "blocked",
              rules: { checks: [{ rule: "rail_allowed", pass: false, detail: "" }] },
            },
            blockedBy: "rules",
          },
        },
      } as unknown as LoggedEvent,
    ];
    const [row] = deskRows(
      passesOf(events, warrants),
      [],
      () => "Treasury · licence",
      (id) => payeeName(id, warrants),
    ) as PayRow[];
    expect(row?.to).toBe("Our treasury (to Airwallex)");
    expect(paySentence(row as PayRow)).toBe(
      "Treasury · licence asked to pay 0.15 USDZ to Our treasury (to Airwallex). Blocked: rail not on the warrant.",
    );
  });

  it("uses 'a customer' only for real refund/customer payees and otherwise shows the payee id", () => {
    const liveWarrants = [wrtTreasury];
    expect(payeeName("pay_treasury", liveWarrants)).toBe("pay_treasury");
    expect(payeeName("pay_rogue", liveWarrants)).toBe("pay_rogue");
    expect(payeeName("customer", liveWarrants)).toBe("a customer");
    expect(payeeName("cus_1001", liveWarrants)).toBe("a customer");
    expect(payeeName(OTHER, liveWarrants)).toBe("a customer");
    expect(payeeName("ord_payer", liveWarrants, { refundOfOrderId: "ord_1001" })).toBe(
      "a customer",
    );

    const events: LoggedEvent[] = [
      {
        seq: 1,
        at,
        event: {
          type: "proposal",
          proposal: {
            proposalId: "prop_sweep_live",
            warrantId: "wrt_treasury",
            payeeId: "pay_treasury",
            amount: usdz(15),
            rail: "metal_x402",
            category: "treasury_sweep",
          },
          result: {
            decision: {
              outcome: "blocked",
              rules: { checks: [{ rule: "rail_allowed", pass: false, detail: "" }] },
            },
            blockedBy: "rules",
          },
        },
      } as unknown as LoggedEvent,
      {
        seq: 2,
        at,
        event: {
          type: "proposal",
          proposal: {
            proposalId: "prop_refund_1",
            warrantId: "wrt_support",
            payeeId: "customer",
            amount: usdz(2),
            rail: "metal_x402",
            category: "customer_refund",
            refundOfOrderId: "ord_1001",
          },
          result: { decision: { outcome: "execute" } },
        },
      } as unknown as LoggedEvent,
    ];
    const built = deskRows(
      passesOf(events, liveWarrants),
      [],
      (id) => (id === "wrt_treasury" ? "Treasury · licence" : "Support agent"),
      (id) => payeeName(id, liveWarrants),
    ) as PayRow[];
    expect(built.map((r) => r.to)).toEqual(["a customer", "pay_treasury"]);
  });
});
