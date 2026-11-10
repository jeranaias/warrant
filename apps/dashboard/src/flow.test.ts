import { describe as group, expect, it } from "vitest";
import type { LoggedEvent, WarrantRow } from "./api.js";
import {
  OTHER,
  REASONS,
  leftFraction,
  limitRequests,
  paidByCurrency,
  passesOf,
  payeeNodes,
  reasonsOf,
  tally,
} from "./flow.js";

const usd = (cents: number) => ({ currency: "USDZ" as const, cents });
const warrant = (warrantId: string, payees: string[]): WarrantRow => ({
  warrantId,
  version: 1,
  agentId: `agt_${warrantId}`,
  agentRole: "sourcing",
  purpose: "",
  allowedRails: [],
  payees: payees.map((payeeId) => ({
    payeeId,
    displayName: payeeId,
    rail: "metal_x402",
    currency: "USDZ",
  })),
  perPaymentCap: usd(10),
  totalBudget: usd(100),
  spentCents: 0,
});
const asked = (seq: number, warrantId: string, payeeId: string, outcome?: string): LoggedEvent =>
  ({
    seq,
    at: "2026-11-02T00:00:00Z",
    event: {
      type: "proposal",
      proposal: { warrantId, payeeId, amount: usd(5) },
      result: outcome ? { decision: { outcome } } : { error: "malformed" },
    },
  }) as unknown as LoggedEvent;

group("flow map data", () => {
  const warrants = [warrant("w1", ["pay_a"]), warrant("w2", [])];

  it("one node per named payee, plus customers when a warrant pays no one by name", () => {
    expect(payeeNodes(warrants).map((n) => n.id)).toEqual(["pay_a", OTHER]);
    expect(payeeNodes([warrant("w1", ["pay_a"])]).map((n) => n.id)).toEqual(["pay_a"]);
  });

  it("every proposal is paid, blocked or asks the owner; a malformed one counts as blocked", () => {
    const passes = passesOf(
      [
        asked(1, "w1", "pay_a", "execute"),
        asked(2, "w1", "pay_x", "blocked"),
        asked(3, "w2", "cus_1", "needs_owner_approval"),
        asked(4, "w2", "cus_1"),
      ],
      warrants,
    );
    expect(passes.map((p) => [p.payee, p.fate])).toEqual([
      ["pay_a", "paid"],
      ["pay_x", "blocked"],
      [OTHER, "asked"],
      [OTHER, "blocked"],
    ]);
    const t = tally(passes);
    expect(t.total).toEqual({ paid: 1, blocked: 2, asked: 1 });
    expect(t.lanes.get("w2")).toEqual({ paid: 0, blocked: 1, asked: 1 });
    expect(t.paidTo.get("pay_a")).toEqual(usd(5));
  });

  it("budget left is a share from 0 to 1, never outside it", () => {
    expect(leftFraction(0, 1000)).toBe(1);
    expect(leftFraction(250, 1000)).toBe(0.75);
    expect(leftFraction(1500, 1000)).toBe(0);
    expect(leftFraction(5, 0)).toBe(0);
  });
});

group("gate reasons and owner outcomes", () => {
  const warrants = [warrant("w1", ["pay_a"])];
  const event = (seq: number, e: unknown): LoggedEvent =>
    ({ seq, at: "2026-11-02T00:00:00Z", event: e }) as LoggedEvent;
  const proposal = (seq: number, id: string, result: unknown) =>
    event(seq, {
      type: "proposal",
      proposal: { proposalId: id, warrantId: "w1", payeeId: "pay_a", amount: usd(5) },
      result,
    });
  const failing = (rule: string) => ({
    decision: { outcome: "blocked", rules: { checks: [{ rule, pass: false, detail: "" }] } },
    blockedBy: "rules",
  });

  it("labels a block by the first rule that failed, else by who blocked it", () => {
    const passes = passesOf(
      [
        proposal(1, "p1", failing("duplicate_guard")),
        proposal(2, "p2", failing("duplicate_guard")),
        proposal(3, "p3", failing("total_budget")),
        proposal(4, "p4", {
          decision: { outcome: "blocked", purpose: null },
          blockedBy: "purpose",
        }),
      ],
      warrants,
    );
    expect(passes.map((p) => p.reason)).toEqual([
      REASONS["duplicate_guard"],
      REASONS["duplicate_guard"],
      REASONS["total_budget"],
      REASONS["purpose"],
    ]);
    expect(reasonsOf(passes)[0]).toEqual({ reason: REASONS["duplicate_guard"], n: 2 });
  });

  it("a held request becomes paid or blocked once the owner decides; a failed rail is blocked", () => {
    const held = { decision: { outcome: "needs_owner_approval" } };
    const passes = passesOf(
      [
        proposal(1, "p1", held),
        proposal(2, "p2", held),
        proposal(3, "p3", held),
        proposal(4, "p4", { decision: { outcome: "execute" } }),
        event(5, { type: "approval_decided", proposalId: "p1", ok: true, decision: "approved" }),
        event(6, { type: "approval_decided", proposalId: "p2", ok: true, decision: "denied" }),
        event(7, { type: "execution", proposalId: "p4", execution: { status: "failed" } }),
      ],
      warrants,
    );
    expect(passes.map((p) => [p.fate, p.reason])).toEqual([
      ["paid", undefined],
      ["blocked", REASONS["owner"]],
      ["asked", undefined],
      ["blocked", REASONS["rail"]],
    ]);
    expect(paidByCurrency(passes)).toEqual([usd(5)]);
  });

  it("a purchase the card itself declined reads as the card's refusal", () => {
    const passes = passesOf(
      [
        event(1, {
          type: "proposal",
          proposal: {
            proposalId: "c1",
            warrantId: "w1",
            payeeId: "pay_a",
            amount: usd(5),
            rail: "airwallex_card",
          },
          result: { decision: { outcome: "execute" } },
        }),
        event(2, {
          type: "execution",
          proposalId: "c1",
          execution: { status: "failed", detail: "declined by card: LIMIT_EXCEEDED" },
        }),
      ],
      warrants,
    );
    expect(passes.map((p) => [p.fate, p.reason])).toEqual([["blocked", "declined by the card"]]);
  });
});

group("held for you", () => {
  it("counts new limits waiting for the owner, not payments waiting", () => {
    const approvals = [
      { view: { kind: "budget_change" } },
      { view: { amount: usd(5) } },
      { view: { kind: "budget_change" } },
    ];
    expect(limitRequests(approvals)).toBe(2);
    expect(limitRequests([])).toBe(0);
  });

  it("drops waiting payments when approvals are empty after STOP", () => {
    const warrants = [warrant("w1", ["pay_a"])];
    const events: LoggedEvent[] = [
      {
        seq: 1,
        at: "2026-11-02T00:00:00Z",
        event: {
          type: "proposal",
          proposal: { proposalId: "p1", warrantId: "w1", payeeId: "pay_a", amount: usd(5) },
          result: { decision: { outcome: "needs_owner_approval" } },
        },
      } as unknown as LoggedEvent,
      {
        seq: 2,
        at: "2026-11-02T00:00:01Z",
        event: {
          type: "kill_switch",
          result: {
            event: { reason: "stop", at: "2026-11-02T00:00:01Z", revokedWarrantIds: ["w1"] },
            revokedMandates: [],
            problems: [],
            durationMs: 5,
          },
        },
      },
    ];
    expect(tally(passesOf(events.slice(0, 1), warrants, [{ proposalId: "p1" }])).total.asked).toBe(
      1,
    );
    expect(tally(passesOf(events.slice(0, 1), warrants, [])).total.asked).toBe(0);
    const approvals: { proposalId: string; view: Record<string, unknown> }[] = [];
    const passes = passesOf(events, warrants, approvals);
    expect(tally(passes).total.asked + limitRequests(approvals)).toBe(0);
  });
});
