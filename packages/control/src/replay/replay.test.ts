import { generateKeyPairSync } from "node:crypto";
import { describe, expect, it } from "vitest";
import type { PaymentProposal, PurposeVerdict, Warrant, WarrantBody } from "@warrant/contracts";
import type { RailAdapter, RailResult } from "@warrant/rails";
import { AGENT_BUDGETS, UPSTREAM_PRICE_BEFORE } from "../business.js";
import { Controller } from "../controller.js";
import { signWarrant } from "../crypto.js";
import { replay } from "./index.js";
import type { ReplayEvent, ReplayStep } from "./index.js";

const NOW = new Date("2026-11-01T12:00:00Z");
const usdz = (cents: number) => ({ currency: "USDZ" as const, cents });
const { privateKey, publicKey } = generateKeyPairSync("ed25519");

const body: WarrantBody = {
  warrantId: "wrt_sourcing",
  version: 1,
  ownerId: "own_1",
  agentId: "agt_sourcing",
  agentRole: "sourcing",
  purpose: "Buy upstream market data to resell to customers.",
  allowedRails: ["metal_x402"],
  payees: [
    {
      payeeId: "pay_upstream",
      displayName: "Upstream data",
      rail: "metal_x402",
      routingRef: "0x" + "1".repeat(40),
      currency: "USDZ",
    },
  ],
  perPaymentCap: AGENT_BUDGETS.sourcing.perPaymentCap,
  totalBudget: AGENT_BUDGETS.sourcing.budget,
  notBefore: "2026-10-29T00:00:00Z",
  expiresAt: "2026-11-13T00:00:00Z",
  mandate: {
    network: "eip155:63825",
    mandateId: "mnd_1",
    principal: "0x" + "a".repeat(40),
    cap: usdz(3),
    budget: usdz(1000),
    expiresAt: "2026-11-13T00:00:00Z",
  },
};

class FakeRail implements RailAdapter {
  readonly rail = "metal_x402" as const;
  next: RailResult = { status: "succeeded", railRef: "0xtx" };
  status: RailResult = { status: "unknown" };
  execute(): Promise<RailResult> {
    return Promise.resolve(this.next);
  }
  getStatus(): Promise<RailResult> {
    return Promise.resolve(this.status);
  }
}

function setup(verdict: PurposeVerdict["verdict"] = "consistent") {
  const rail = new FakeRail();
  const warrant: Warrant = signWarrant(body, privateKey, "owner-k1");
  const log: ReplayEvent[] = [];
  const controller = new Controller({
    ownerPublicKey: publicKey,
    getWarrant: (id) => (id === warrant.warrantId ? warrant : undefined),
    rails: { metal_x402: rail },
    purpose: {
      model: "test-model",
      check: (_w, s, now) =>
        Promise.resolve({
          proposalId: s.proposalId,
          verdict,
          reasons: [
            verdict === "consistent" ? "matches_warrant_purpose" : "outside_warrant_purpose",
          ],
          explanation: "test",
          model: "test-model",
          evaluatedAt: now.toISOString(),
        }),
    },
    credentialFor: () => "sourcing.json",
    clock: () => NOW,
    onEvent: (event) => log.push({ at: NOW.toISOString(), event }),
  });
  const replayOf = (id: string) => replay(id, log, controller.ledger.all());
  return { rail, controller, replayOf };
}

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
  justification: "buy the feed",
  createdAt: NOW.toISOString(),
  ...over,
});

const decide = (c: Controller, proposalId: string, decision: "approved" | "denied") =>
  c.decideApproval({
    approvalId: `apr_${proposalId}`,
    proposalId,
    shownHash: c.approvals.get(proposalId)?.shownHash ?? "",
    decision,
    ownerId: "own_1",
    decidedAt: NOW.toISOString(),
  });

const kinds = (steps: ReplayStep[]) =>
  steps.map((s) => (s.kind === "ledger" ? `ledger:${s.entry}` : s.kind));

describe("replay", () => {
  it("a paid purchase: asked, every rule, purpose, reserve, confirm with the rail's answer", async () => {
    const { controller, replayOf } = setup();
    const p = proposal();
    await controller.submit(p);
    const r = replayOf(p.proposalId);
    expect(r.found).toBe(true);
    expect(r.outcome).toBe("paid");
    expect(kinds(r.steps)).toEqual([
      "asked",
      "rules",
      "purpose",
      "ledger:reserve",
      "ledger:confirm",
    ]);
    const rules = r.steps.find((s) => s.kind === "rules");
    expect(rules?.kind === "rules" && rules.checks.every((c) => c.pass)).toBe(true);
    const confirm = r.steps.at(-1);
    expect(confirm?.kind === "ledger" && confirm.railRef).toBe("0xtx");
    expect(confirm?.kind === "ledger" && confirm.rail?.status).toBe("succeeded");
  });

  it("blocked by a rule: names the failing rule, no purpose check, nothing reserved", async () => {
    const { controller, replayOf } = setup();
    const p = proposal({ amount: usdz(4) });
    await controller.submit(p);
    const r = replayOf(p.proposalId);
    expect(r.outcome).toBe("blocked");
    expect(r.stoppedBy).toBe("rules");
    expect(kinds(r.steps)).toEqual(["asked", "rules", "purpose_skipped"]);
    const rules = r.steps[1];
    const failed = rules?.kind === "rules" ? rules.checks.filter((c) => !c.pass) : [];
    expect(failed.map((c) => c.rule)).toContain("per_payment_cap");
  });

  it("blocked by the purpose check: its verdict and reasons", async () => {
    const { controller, replayOf } = setup("inconsistent");
    const p = proposal();
    await controller.submit(p);
    const r = replayOf(p.proposalId);
    expect(r.outcome).toBe("blocked");
    expect(r.stoppedBy).toBe("purpose");
    const purpose = r.steps.find((s) => s.kind === "purpose");
    expect(purpose?.kind === "purpose" && purpose.verdict).toBe("inconsistent");
    expect(purpose?.kind === "purpose" && purpose.reasons).toEqual(["outside_warrant_purpose"]);
    expect(kinds(r.steps)).not.toContain("ledger:reserve");
  });

  it("held, then denied by the owner: the reasons, the shown hash, and no money moved", async () => {
    const { controller, replayOf } = setup("uncertain");
    const p = proposal();
    await controller.submit(p);
    expect(replayOf(p.proposalId).outcome).toBe("waiting");
    const hash = controller.approvals.get(p.proposalId)?.shownHash;
    await decide(controller, p.proposalId, "denied");
    const r = replayOf(p.proposalId);
    expect(r.outcome).toBe("denied");
    expect(r.stoppedBy).toBe("owner");
    const asked = r.steps.find((s) => s.kind === "owner_asked");
    expect(asked?.kind === "owner_asked" && asked.shownHash).toBe(hash);
    expect(asked?.kind === "owner_asked" && asked.reasons.length).toBeGreaterThan(0);
    expect(kinds(r.steps)).toEqual(["asked", "rules", "purpose", "owner_asked", "owner_decided"]);
  });

  it("held, approved, then paid", async () => {
    const { controller, replayOf } = setup("uncertain");
    const p = proposal();
    await controller.submit(p);
    await decide(controller, p.proposalId, "approved");
    const r = replayOf(p.proposalId);
    expect(r.outcome).toBe("paid");
    expect(kinds(r.steps).slice(-4)).toEqual([
      "owner_asked",
      "owner_decided",
      "ledger:reserve",
      "ledger:confirm",
    ]);
  });

  it("the rail refuses: released, stopped by the rail, with its detail", async () => {
    const { rail, controller, replayOf } = setup();
    rail.next = { status: "failed", detail: "seller refused" };
    const p = proposal();
    await controller.submit(p);
    const r = replayOf(p.proposalId);
    expect(r.outcome).toBe("rail_failed");
    expect(r.stoppedBy).toBe("rail");
    const release = r.steps.at(-1);
    expect(release?.kind === "ledger" && release.entry).toBe("release");
    expect(release?.kind === "ledger" && release.rail?.detail).toBe("seller refused");
  });

  it("a timeout stays unconfirmed, then a status check settles it as paid (ADR-019)", async () => {
    const { rail, controller, replayOf } = setup();
    rail.next = { status: "unknown" };
    const p = proposal();
    await controller.submit(p);
    expect(replayOf(p.proposalId).outcome).toBe("unconfirmed");
    rail.status = { status: "succeeded", railRef: "0xlate" };
    await controller.reconcile();
    const r = replayOf(p.proposalId);
    expect(r.outcome).toBe("paid");
    expect(kinds(r.steps).slice(-3)).toEqual([
      "ledger:reserve",
      "ledger:unconfirmed",
      "ledger:confirm",
    ]);
    const confirm = r.steps.at(-1);
    expect(confirm?.kind === "ledger" && confirm.rail?.statusCheck).toBe(true);
    expect(confirm?.kind === "ledger" && confirm.railRef).toBe("0xlate");
  });

  it("an id nothing recorded is not found", () => {
    const { replayOf } = setup();
    expect(replayOf("prop_nope").found).toBe(false);
  });
});
