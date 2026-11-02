import { describe, expect, it } from "vitest";
import type { PaymentProposal } from "@warrant/contracts";
import { simulateTransfer } from "@warrant/rails";
import { mockAirwallexWorld } from "./earnings.js";
import type { AirwallexWorld } from "./earnings.js";
import { createEngine } from "./server.js";
import { AGENTS } from "./world.js";

/**
 * Issue #21 end to end: control + the Airwallex adapter + the Airwallex mock's own faults. A timeout
 * leaves the licence fee unconfirmed with the money held; only a status check settles it, and
 * whatever happens there is exactly one transfer.
 */

const NOW = new Date("2026-11-01T12:00:00Z");
const CREATE = "/api/v1/transfers/create";

const fee = (key: string, proposalId = `prop_${key}`): PaymentProposal => ({
  proposalId,
  warrantId: AGENTS.treasury.warrantId,
  agentId: AGENTS.treasury.agentId,
  agentRole: "treasury",
  rail: "airwallex_transfer",
  payeeId: "pay_licensor",
  amount: { currency: "EUR", cents: 5000 },
  category: "licence_fee",
  recurrence: "one_off",
  idempotencyKey: key,
  justification: "Invoice INV-1107: monthly data licence",
  createdAt: NOW.toISOString(),
});

async function setup() {
  const awx = await mockAirwallexWorld(NOW, { timeoutMs: 50 });
  const engine = createEngine({ scenario: "none", clock: () => NOW, world: awx.world });
  const { controller } = engine;
  const transfers = () => awx.mock?.state.transfers.size ?? -1;
  const held = () => controller.ledger.committedCents(AGENTS.treasury.warrantId);
  return { awx, controller, transfers, held };
}

/** The transfer the mock made for this key (the test's view, not the adapter's). */
async function transferId(awx: AirwallexWorld, key: string): Promise<string> {
  const r = await awx.client.call("GET", `/api/v1/transfers?request_id=${key}`);
  return String((r.body as { items: { id: string }[] }).items[0]?.id);
}

describe("a rail timeout: unconfirmed, then a status check, never a second payment (#21)", () => {
  it("timeout, then the bank pays it: confirmed once, one transfer", async () => {
    const { awx, controller, transfers, held } = await setup();
    try {
      awx.mock?.fault({ kind: "timeout-after", ms: 400, method: "POST", path: CREATE });
      const r = await controller.submit(fee("fee-timeout-paid"));
      expect(r.execution).toMatchObject({ status: "unknown", detail: "timed out" });
      expect(controller.ledger.unconfirmed()).toHaveLength(1);
      expect(held()).toBe(5000);
      expect(transfers()).toBe(1); // the mock did the work before the timeout

      const id = await transferId(awx, "fee-timeout-paid");
      for (const next of ["PROCESSING", "SENT", "PAID"] as const) {
        await simulateTransfer(awx.client, id, next);
      }
      expect((await controller.reconcile()).confirmed).toHaveLength(1);
      expect(controller.ledger.spentCents(AGENTS.treasury.warrantId)).toBe(5000);
      expect(transfers()).toBe(1);
    } finally {
      await awx.close();
    }
  });

  it("timeout, then the bank cancels it: released, the budget comes back, one transfer", async () => {
    const { awx, controller, transfers, held } = await setup();
    try {
      awx.mock?.fault({ kind: "timeout-after", ms: 400, method: "POST", path: CREATE });
      await controller.submit(fee("fee-timeout-failed"));
      const id = await transferId(awx, "fee-timeout-failed");
      await simulateTransfer(awx.client, id, "PROCESSING");
      await awx.client.call("POST", `/api/v1/simulation/transfers/${id}/transition`, {
        next_status: "CANCELLED",
      });
      expect((await controller.reconcile()).released).toHaveLength(1);
      expect(held()).toBe(0);
      expect(transfers()).toBe(1);
    } finally {
      await awx.close();
    }
  });

  it("the same fee sent again while in doubt is refused; still one transfer", async () => {
    const { awx, controller, transfers } = await setup();
    try {
      awx.mock?.fault({ kind: "timeout-after", ms: 400, method: "POST", path: CREATE });
      await controller.submit(fee("fee-timeout-again"));
      const again = await controller.submit(fee("fee-timeout-again", "prop_again"));
      expect(again.blockedBy).toBe("rules");
      expect(transfers()).toBe(1);
    } finally {
      await awx.close();
    }
  });

  it("a duplicated create (the request ran twice): the adapter looks it up, one transfer", async () => {
    const { awx, controller, transfers } = await setup();
    try {
      awx.mock?.fault({ kind: "duplicate", method: "POST", path: CREATE });
      const r = await controller.submit(fee("fee-duplicate"));
      expect(r.execution?.status).toBe("pending");
      expect(r.execution?.railRef).toBe(await transferId(awx, "fee-duplicate"));
      expect(transfers()).toBe(1);
    } finally {
      await awx.close();
    }
  });
});
