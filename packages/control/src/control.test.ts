import { generateKeyPairSync } from "node:crypto";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { PaymentProposal, SignedOrderRecord, Warrant, WarrantBody } from "@warrant/contracts";
import {
  AGENT_BUDGETS,
  TOTAL_BUDGET,
  UPSTREAM_PRICE_AFTER,
  UPSTREAM_PRICE_BEFORE,
  sumAgentBudgets,
  validateBudgetPlan,
} from "./business.js";
import { canonicalHash, canonicalize, signWarrant, verifyWarrant } from "./crypto.js";
import { Ledger, verifyChain } from "./ledger/index.js";
import { checkRules, mandateProblems } from "./rules/index.js";
import type { RulesContext } from "./rules/index.js";

const NOW = new Date("2026-11-01T12:00:00Z");
const usdz = (cents: number) => ({ currency: "USDZ" as const, cents });
const { privateKey, publicKey } = generateKeyPairSync("ed25519");
const UPSTREAM = "0x" + "1".repeat(40);

const UPSTREAM_PAYEE = {
  payeeId: "pay_upstream",
  displayName: "Upstream data",
  rail: "metal_x402" as const,
  routingRef: UPSTREAM,
  currency: "USDZ" as const,
};
const MANDATE = {
  network: "eip155:63825" as const,
  mandateId: "mnd_1",
  principal: "0x" + "a".repeat(40),
  cap: usdz(3),
  budget: usdz(1000),
  expiresAt: "2026-11-13T00:00:00Z",
};

const body: WarrantBody = {
  warrantId: "wrt_sourcing",
  version: 1,
  ownerId: "own_1",
  agentId: "agt_sourcing",
  agentRole: "sourcing",
  purpose: "Buy upstream market data to resell to customers.",
  allowedRails: ["metal_x402"],
  payees: [UPSTREAM_PAYEE],
  perPaymentCap: AGENT_BUDGETS.sourcing.perPaymentCap,
  totalBudget: AGENT_BUDGETS.sourcing.budget,
  notBefore: "2026-10-29T00:00:00Z",
  expiresAt: "2026-11-13T00:00:00Z",
  mandate: MANDATE,
};
const warrant: Warrant = signWarrant(body, privateKey, "owner-k1");

let n = 0;
const proposal = (over: Partial<PaymentProposal> = {}): PaymentProposal => ({
  proposalId: `prop_${++n}`,
  warrantId: "wrt_sourcing",
  agentId: "agt_sourcing",
  agentRole: "sourcing",
  rail: "metal_x402",
  payeeId: "pay_upstream",
  amount: UPSTREAM_PRICE_BEFORE,
  category: "data_purchase",
  recurrence: "one_off",
  idempotencyKey: `idem-${n}-xxxxxxxx`,
  justification: "batch for customers",
  createdAt: NOW.toISOString(),
  ...over,
});

const ctx = (over: Partial<RulesContext> = {}): RulesContext => ({
  now: NOW,
  signatureValid: true,
  killSwitchEngaged: false,
  committedCents: 0,
  seenIdempotencyKeys: new Set(),
  recentPayments: [],
  ...over,
});

const failed = (r: ReturnType<typeof checkRules>) =>
  r.checks.filter((c) => !c.pass).map((c) => c.rule);

describe("business constants (ADR-009)", () => {
  it("agent budgets add up to the 20 USDZ total", () => {
    expect(sumAgentBudgets()).toBe(TOTAL_BUDGET.cents);
    expect(TOTAL_BUDGET.cents).toBe(2000);
  });

  it("the upstream rise crosses the sourcing cap", () => {
    expect(UPSTREAM_PRICE_BEFORE.cents).toBeLessThanOrEqual(
      AGENT_BUDGETS.sourcing.perPaymentCap.cents,
    );
    expect(UPSTREAM_PRICE_AFTER.cents).toBeGreaterThan(AGENT_BUDGETS.sourcing.perPaymentCap.cents);
  });

  it("a budget plan must stay within the total and exceed what is spent", () => {
    const spent = { sourcing: 300, support: 0, treasury: 50 };
    expect(validateBudgetPlan({ sourcing: 1200, support: 300, treasury: 500 }, spent)).toEqual([]);
    expect(validateBudgetPlan({ sourcing: 1300, support: 400, treasury: 600 }, spent)).toEqual([
      "total 2300 exceeds 2000",
    ]);
    expect(validateBudgetPlan({ sourcing: 300, support: 400, treasury: 600 }, spent)).toEqual([
      "sourcing: budget 300 must exceed spent 300",
    ]);
  });
});

describe("canonical JSON + warrant signatures (ADR-005)", () => {
  it("key order does not matter; undefined members are dropped", () => {
    expect(canonicalize({ b: 1, a: [true, null, "x"], c: undefined })).toBe(
      '{"a":[true,null,"x"],"b":1}',
    );
    expect(canonicalHash({ a: 1, b: 2 })).toBe(canonicalHash({ b: 2, a: 1 }));
  });

  it("rejects values JSON can't carry faithfully", () => {
    expect(() => canonicalize(Number.NaN)).toThrow();
    expect(() => canonicalize(new Date())).toThrow();
    expect(() => canonicalize(10n)).toThrow();
  });

  it("a signed warrant verifies; any edit breaks it", () => {
    expect(verifyWarrant(warrant, publicKey)).toBe(true);
    expect(verifyWarrant({ ...warrant, totalBudget: usdz(100000) }, publicKey)).toBe(false);
    const payees = [{ ...UPSTREAM_PAYEE, routingRef: "0x" + "9".repeat(40) }];
    expect(verifyWarrant({ ...warrant, payees }, publicKey)).toBe(false);
  });

  it("another key's signature does not verify", () => {
    const other = generateKeyPairSync("ed25519");
    expect(verifyWarrant(warrant, other.publicKey)).toBe(false);
  });

  it("revoking (status change) does not need a re-sign", () => {
    expect(verifyWarrant({ ...warrant, status: "revoked" }, publicKey)).toBe(true);
  });
});

describe("rules check", () => {
  it("passes a normal 2-cent upstream purchase", () => {
    const r = checkRules(warrant, proposal(), ctx());
    expect(failed(r)).toEqual([]);
    expect(r.pass).toBe(true);
    expect(r.checks).toHaveLength(9);
  });

  it("refuses the purchase after the price rises to 4 cents", () => {
    const r = checkRules(warrant, proposal({ amount: UPSTREAM_PRICE_AFTER }), ctx());
    expect(failed(r)).toEqual(["per_payment_cap"]);
  });

  it("cap and budget are inclusive", () => {
    expect(checkRules(warrant, proposal({ amount: usdz(3) }), ctx()).pass).toBe(true);
    expect(
      checkRules(warrant, proposal({ amount: usdz(3) }), ctx({ committedCents: 997 })).pass,
    ).toBe(true);
    expect(
      failed(checkRules(warrant, proposal({ amount: usdz(3) }), ctx({ committedCents: 998 }))),
    ).toEqual(["total_budget"]);
  });

  it("expiry is inclusive at both ends", () => {
    const at = (iso: string) => checkRules(warrant, proposal(), ctx({ now: new Date(iso) }));
    expect(at("2026-10-29T00:00:00Z").pass).toBe(true);
    expect(at("2026-11-13T00:00:00Z").pass).toBe(true);
    expect(failed(at("2026-11-13T00:00:00.001Z"))).toEqual(["warrant_expiry"]);
    expect(failed(at("2026-10-28T23:59:59.999Z"))).toEqual(["warrant_expiry"]);
  });

  it("a payee that is not on the warrant is refused (fake price notice swaps the address)", () => {
    expect(failed(checkRules(warrant, proposal({ payeeId: "pay_attacker" }), ctx()))).toEqual([
      "payee_allowlist",
    ]);
  });

  it("refuses a wrong currency", () => {
    const r = checkRules(warrant, proposal({ amount: { currency: "USD", cents: 2 } }), ctx());
    expect(failed(r)).toEqual(["currency_match"]);
  });

  it("refuses a rail the warrant does not allow", () => {
    expect(failed(checkRules(warrant, proposal({ rail: "airwallex_transfer" }), ctx()))).toContain(
      "rail_allowed",
    );
  });

  it("kill switch, revocation, a bad signature or another agent all fail warrant_active", () => {
    expect(failed(checkRules(warrant, proposal(), ctx({ killSwitchEngaged: true })))).toEqual([
      "warrant_active",
    ]);
    expect(failed(checkRules({ ...warrant, status: "revoked" }, proposal(), ctx()))).toEqual([
      "warrant_active",
    ]);
    expect(failed(checkRules(warrant, proposal(), ctx({ signatureValid: false })))).toEqual([
      "warrant_active",
    ]);
    expect(failed(checkRules(warrant, proposal({ agentId: "agt_support" }), ctx()))).toEqual([
      "warrant_active",
    ]);
  });

  it("a warrant that exceeds its mandate is not active (ADR-009)", () => {
    const big = { ...warrant, perPaymentCap: usdz(4) };
    expect(mandateProblems(big)).toEqual(["cap exceeds mandate cap"]);
    const { mandate: _m, ...noMandate } = warrant;
    void _m;
    expect(mandateProblems(noMandate)).toEqual(["metal_x402 warrant has no mandate"]);
  });

  it("a reused idempotency key is a duplicate", () => {
    const p = proposal();
    expect(
      failed(checkRules(warrant, p, ctx({ seenIdempotencyKeys: new Set([p.idempotencyKey]) }))),
    ).toEqual(["duplicate_guard"]);
  });

  it("repeat x402 purchases of the same price are not duplicates (ADR-011)", () => {
    const recent = [{ payeeId: "pay_upstream", rail: "metal_x402" as const, cents: 2, at: NOW }];
    expect(checkRules(warrant, proposal(), ctx({ recentPayments: recent })).pass).toBe(true);
  });

  it("one offer is paid once: a flood from a single offer stops at the second purchase", () => {
    const recent = [
      {
        payeeId: "pay_upstream",
        rail: "metal_x402" as const,
        cents: 2,
        at: NOW,
        sourceRef: "src_1",
      },
    ];
    const r = checkRules(
      warrant,
      proposal({ sourceRef: "src_1" }),
      ctx({ recentPayments: recent }),
    );
    expect(failed(r)).toEqual(["duplicate_guard"]);
    expect(r.checks.find((c) => c.rule === "duplicate_guard")?.detail).toBe(
      "this offer or invoice was already paid once",
    );
    // The next offer is a new purchase.
    expect(
      checkRules(warrant, proposal({ sourceRef: "src_2" }), ctx({ recentPayments: recent })).pass,
    ).toBe(true);
  });
});

describe("rules: Airwallex duplicate window and refunds", () => {
  const treasury: Warrant = signWarrant(
    {
      ...body,
      warrantId: "wrt_treasury",
      agentId: "agt_treasury",
      agentRole: "treasury",
      allowedRails: ["airwallex_transfer"],
      payees: [
        {
          payeeId: "pay_licensor",
          displayName: "Data licensor",
          rail: "airwallex_transfer",
          routingRef: "ben_123",
          currency: "EUR",
        },
      ],
      perPaymentCap: { currency: "EUR", cents: 5000 },
      totalBudget: { currency: "EUR", cents: 10000 },
    },
    privateKey,
    "owner-k1",
  );
  const fee = (over: Partial<PaymentProposal> = {}) =>
    proposal({
      warrantId: "wrt_treasury",
      agentId: "agt_treasury",
      agentRole: "treasury",
      rail: "airwallex_transfer",
      payeeId: "pay_licensor",
      amount: { currency: "EUR", cents: 5000 },
      category: "licence_fee",
      ...over,
    });

  it("same payee + amount within 10 minutes is a duplicate; at 10:00.001 it is not", () => {
    const at = (ms: number) => [
      {
        payeeId: "pay_licensor",
        rail: "airwallex_transfer" as const,
        cents: 5000,
        at: new Date(NOW.getTime() - ms),
      },
    ];
    expect(failed(checkRules(treasury, fee(), ctx({ recentPayments: at(600_000) })))).toEqual([
      "duplicate_guard",
    ]);
    expect(checkRules(treasury, fee(), ctx({ recentPayments: at(600_001) })).pass).toBe(true);
  });

  const support: Warrant = signWarrant(
    {
      ...body,
      warrantId: "wrt_support",
      agentId: "agt_support",
      agentRole: "support",
      payees: [],
      perPaymentCap: AGENT_BUDGETS.support.perPaymentCap,
      totalBudget: AGENT_BUDGETS.support.budget,
      mandate: { ...MANDATE, cap: usdz(400), budget: usdz(400) },
    },
    privateKey,
    "owner-k1",
  );
  const order: SignedOrderRecord = {
    orderId: "ord_1",
    resource: "GET /query/fx-eurusd",
    price: usdz(5),
    payee: "0x" + "b".repeat(40),
    payer: "0x" + "c".repeat(40),
    network: "eip155:63825",
    txHash: "0x" + "d".repeat(64),
    settlementId: "set_1",
    signedOffer: "{}",
    deliveredSha256: "e".repeat(64),
    at: NOW.toISOString(),
  };
  const refund = (over: Partial<PaymentProposal> = {}) =>
    proposal({
      warrantId: "wrt_support",
      agentId: "agt_support",
      agentRole: "support",
      payeeId: "customer",
      amount: usdz(5),
      category: "customer_refund",
      refundOfOrderId: "ord_1",
      ...over,
    });
  const orders = new Map([["ord_1", order]]);

  it("a refund of a stored order passes", () => {
    expect(failed(checkRules(support, refund(), ctx({ orders })))).toEqual([]);
  });

  it("refund more than the order, twice, of an unknown order, or with no order is refused", () => {
    expect(failed(checkRules(support, refund({ amount: usdz(6) }), ctx({ orders })))).toEqual([
      "refund_matches_order",
    ]);
    expect(
      failed(checkRules(support, refund(), ctx({ orders, refundedOrderIds: new Set(["ord_1"]) }))),
    ).toEqual(["refund_matches_order"]);
    expect(
      failed(checkRules(support, refund({ refundOfOrderId: "ord_9" }), ctx({ orders }))),
    ).toEqual(["refund_matches_order"]);
    const { refundOfOrderId: _r, ...noOrder } = refund();
    void _r;
    expect(failed(checkRules(support, noOrder, ctx({ orders })))).toEqual(["refund_matches_order"]);
  });

  it("a refund covers only the orders of the stored dispute it answers (#84)", () => {
    const two = new Map([...orders, ["ord_2", { ...order, orderId: "ord_2" }]]);
    const dispute = {
      disputeId: "dsp_1",
      customer: order.payer,
      orderIds: ["ord_1"],
      claim: "wrong_data" as const,
      ticketRef: "src_ticket_1",
      openedAt: NOW.toISOString(),
    };
    const disputes = new Map([["src_ticket_1", dispute]]);
    const detail = (p: PaymentProposal) =>
      checkRules(support, p, ctx({ orders: two, disputes })).checks.find(
        (c) => c.rule === "refund_matches_order",
      );
    expect(detail(refund({ sourceRef: "src_ticket_1" }))?.pass).toBe(true);
    // budget-drain-003: the dispute names ord_1, the ticket text adds ord_2
    expect(detail(refund({ sourceRef: "src_ticket_1", refundOfOrderId: "ord_2" }))).toEqual({
      rule: "refund_matches_order",
      pass: false,
      detail: "ord_2 is not in the dispute",
    });
    // no ticket, or a ticket with no dispute on file
    expect(detail(refund())?.detail).toBe("refund answers no stored dispute");
    expect(detail(refund({ sourceRef: "src_other" }))?.detail).toBe(
      "refund answers no stored dispute",
    );
  });
});

describe("ledger", () => {
  const res = (l: Ledger, key: string, cents = 2) =>
    l.reserve({
      proposalId: `p_${key}`,
      warrantId: "wrt_sourcing",
      rail: "metal_x402",
      amount: usdz(cents),
      idempotencyKey: key,
      payeeId: "pay_upstream",
    });

  it("reserve -> confirm counts as spent; reserve -> release frees the money", () => {
    const l = new Ledger();
    const a = res(l, "k-aaaaaaaa");
    const b = res(l, "k-bbbbbbbb");
    expect(l.committedCents("wrt_sourcing")).toBe(4);
    l.confirm(a.reservationId, "0xtx");
    l.release(b.reservationId);
    expect(l.spentCents("wrt_sourcing")).toBe(2);
    expect(l.committedCents("wrt_sourcing")).toBe(2);
    expect(l.get(a.reservationId).railRef).toBe("0xtx");
  });

  it("an idempotency key can be reserved once, ever", () => {
    const l = new Ledger();
    res(l, "k-aaaaaaaa");
    expect(() => res(l, "k-aaaaaaaa")).toThrow(/already reserved/);
  });

  it("a timeout holds the money as unconfirmed until resolved", () => {
    const l = new Ledger();
    const a = res(l, "k-aaaaaaaa");
    l.markUnconfirmed(a.reservationId);
    expect(l.committedCents("wrt_sourcing")).toBe(2);
    expect(l.unconfirmed()).toHaveLength(1);
    l.confirm(a.reservationId, "0xtx");
    expect(l.unconfirmed()).toHaveLength(0);
    expect(() => l.release(a.reservationId)).toThrow(/already confirmed/);
  });

  it("kill switch releases open reservations but keeps unconfirmed ones held", () => {
    const l = new Ledger();
    const a = res(l, "k-aaaaaaaa");
    const b = res(l, "k-bbbbbbbb");
    l.markUnconfirmed(b.reservationId);
    const { releasedReservationIds } = l.killSwitch();
    expect(releasedReservationIds).toEqual([a.reservationId]);
    expect(l.get(b.reservationId).state).toBe("unconfirmed");
  });

  it("the hash chain detects an edited entry", () => {
    const l = new Ledger();
    l.confirm(res(l, "k-aaaaaaaa").reservationId, "0xtx");
    expect(verifyChain(l.all())).toBeNull();
    const edited = l.all().map((e, i) => (i === 0 ? { ...e, amount: usdz(1) } : e));
    expect(verifyChain(edited)).toBe(0);
  });

  it("persists to a file, reloads, and refuses a tampered file", () => {
    const file = join(mkdtempSync(join(tmpdir(), "ledger-")), "ledger.jsonl");
    const l = new Ledger(file);
    const a = res(l, "k-aaaaaaaa");
    l.confirm(a.reservationId, "0xtx");
    const again = new Ledger(file);
    expect(again.spentCents("wrt_sourcing")).toBe(2);
    expect(again.hasKey("k-aaaaaaaa")).toBe(true);
    expect(again.get(a.reservationId).payeeId).toBe("pay_upstream");
    writeFileSync(file, readFileSync(file, "utf8").replace('"cents":2', '"cents":1'));
    expect(() => new Ledger(file)).toThrow(/tampered/);
  });
});
