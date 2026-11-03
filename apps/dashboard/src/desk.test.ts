import { describe, expect, it } from "vitest";
import type { PendingApproval } from "./api.js";
import { askGroups, deskRows, filterCounts, filterRows, paySentence } from "./desk.js";
import type { PayRow } from "./desk.js";
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
