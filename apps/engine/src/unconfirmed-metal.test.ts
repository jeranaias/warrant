import { describe, expect, it } from "vitest";
import type { PaymentProposal } from "@warrant/contracts";
import type { MetalFault } from "@warrant/mocks/metal";
import { UPSTREAM_PAY_TO, UPSTREAM_URL } from "@warrant/mocks/metal";
import { createEngine } from "./server.js";
import { AGENTS } from "./world.js";

/**
 * #21 + #14 on the Metal side: control + the real Metal adapter and its CLI parsers + the mock
 * chain's own faults. A payment in doubt stays unconfirmed with the money held; only the
 * facilitator's settlement lookup settles it, and there is never a second payment on chain.
 */

const NOW = new Date("2026-11-01T12:00:00Z");
let n = 0;

const purchase = (key = `idem-metal-${++n}-xxxxxxxx`): PaymentProposal => ({
  proposalId: `prop_metal_${++n}`,
  warrantId: AGENTS.sourcing.warrantId,
  agentId: AGENTS.sourcing.agentId,
  agentRole: "sourcing",
  rail: "metal_x402",
  payeeId: "pay_upstream",
  amount: { currency: "USDZ", cents: 2 },
  category: "data_purchase",
  recurrence: "one_off",
  idempotencyKey: key,
  sourceRef: `offer-metal-${n}`,
  justification: "EUR/USD forecast batch",
  createdAt: NOW.toISOString(),
});

function setup(fault?: MetalFault) {
  const engine = createEngine({ scenario: "none", clock: () => NOW });
  const { controller } = engine;
  const chain = engine.world.chain;
  if (!chain) throw new Error("the mock world has a chain");
  const before = chain.txs.length;
  /** Payments to the upstream seller on chain since setup. */
  const payments = () =>
    chain.txs.slice(before).filter((t) => t.kind === "payment" && t.to === UPSTREAM_PAY_TO).length;
  if (fault) chain.fault({ url: UPSTREAM_URL, ...fault });
  const held = () => controller.ledger.committedCents(AGENTS.sourcing.warrantId);
  const spent = () => controller.ledger.spentCents(AGENTS.sourcing.warrantId);
  return { controller, chain, payments, held, spent };
}

describe("Metal: a payment in doubt is settled by a status check, never paid twice (#21, #14)", () => {
  it("timeout after the money moved: unconfirmed and held, then the lookup confirms it once", async () => {
    const { controller, payments, held, spent } = setup({ kind: "timeout", settled: true });
    const r = await controller.submit(purchase());
    expect(r.execution).toMatchObject({ status: "unknown", detail: "timed out" });
    expect(controller.ledger.unconfirmed()).toHaveLength(1);
    expect(held()).toBe(2);
    expect(payments()).toBe(1);

    expect((await controller.reconcile()).confirmed).toHaveLength(1);
    expect(controller.ledger.unconfirmed()).toHaveLength(0);
    expect(spent()).toBe(2);
    expect(payments()).toBe(1);
  });

  it("timeout before anything was signed: no nonce to look up, so it stays held; nothing paid", async () => {
    const { controller, payments, held } = setup({ kind: "timeout" });
    const r = await controller.submit(purchase());
    expect(r.execution).toMatchObject({ status: "unknown", detail: "timed out" });
    await controller.reconcile();
    // ADR-019: an outcome the rail can't tell stays held; it is never guessed to be failed.
    expect(controller.ledger.unconfirmed()).toHaveLength(1);
    expect(held()).toBe(2);
    expect(payments()).toBe(0);
    // The agent's next purchase still goes through, inside what is left.
    expect((await controller.submit(purchase())).execution?.status).toBe("succeeded");
    expect(payments()).toBe(1);
  });

  it("the answer lost after paying: settled by the lookup, never resent", async () => {
    const { controller, payments, spent } = setup({ kind: "answer-lost" });
    const p = purchase();
    const r = await controller.submit(p);
    expect(r.execution?.status).toBe("unknown");
    expect(r.execution?.railRef).toMatch(/^nonce:0x/);
    expect(payments()).toBe(1);

    // The repeat is refused, and the status check that runs before its decision settles the first.
    const again = await controller.submit({ ...p, proposalId: "prop_metal_again" });
    expect(again.blockedBy).toBe("rules");
    expect(controller.ledger.unconfirmed()).toHaveLength(0);
    expect(spent()).toBe(2);
    expect(payments()).toBe(1);
  });

  it("the answer arrives twice: one payment, paid once", async () => {
    const { controller, chain, payments, spent } = setup({ kind: "duplicate" });
    const r = await controller.submit(purchase());
    expect(r.execution?.status).toBe("succeeded");
    expect(r.execution?.railRef).toBe(chain.txs[chain.txs.length - 1]?.hash);
    expect(payments()).toBe(1);
    expect(spent()).toBe(2);
  });

  it("a settlement the facilitator shows late: unconfirmed until the lookup sees it, then paid", async () => {
    const { controller, payments, held, spent } = setup({ kind: "slow-settle", ms: 300 });
    expect((await controller.submit(purchase())).execution?.status).toBe("unknown");
    await controller.reconcile();
    expect(controller.ledger.unconfirmed()).toHaveLength(1);
    expect(held()).toBe(2);

    await new Promise((r) => setTimeout(r, 350));
    expect((await controller.reconcile()).confirmed).toHaveLength(1);
    expect(spent()).toBe(2);
    expect(payments()).toBe(1);
  });

  for (const fault of [
    { kind: "refuse", reason: "pass rejected" },
    { kind: "5xx" },
  ] satisfies MetalFault[]) {
    it(`the seller ${fault.kind === "refuse" ? "refuses a valid pass" : "errors (5xx)"}: refused, nothing paid, budget unchanged`, async () => {
      const { controller, payments, held, spent } = setup(fault);
      const r = await controller.submit(purchase());
      expect(r.execution?.status).toBe("failed");
      expect(controller.ledger.unconfirmed()).toHaveLength(0);
      expect(held()).toBe(0);
      expect(spent()).toBe(0);
      expect(payments()).toBe(0);
    });
  }
});
