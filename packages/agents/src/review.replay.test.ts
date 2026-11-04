import { describe, expect, it } from "vitest";
import type { AgentTask, BudgetChangeProposal } from "@warrant/contracts";
import type { AgentContext } from "./context.js";
import { ModelBrain } from "./model.js";
import { loadFixtures, replayCreate } from "./replay.js";
import { runTask } from "./runner.js";
import type { ProposalOutcome } from "./runner.js";
import { counterIds } from "./tool.js";

/**
 * Real Haiku answers to treasury's spend review after the upstream price rose 2 -> 4 cents,
 * recorded on 2026-11-04 with the clarified prompt (three separate reviews, mock engine). Before
 * the clarification Haiku also cut support's total "to stay within the review's total", which
 * control refused. Replayed here: no API call.
 */
const fixtures = loadFixtures(new URL("./fixtures/haiku-spend-review.json", import.meta.url));
const usdz = (cents: number) => ({ currency: "USDZ" as const, cents });

const treasury: AgentContext = {
  role: "treasury",
  agentId: "agt_treasury",
  warrantId: "wrt_treasury",
  purpose: "Pay the monthly data licence fee in euros.",
  allowedRails: ["airwallex_transfer"],
  payees: [
    {
      payeeId: "pay_licensor",
      displayName: "Data licensor (EUR)",
      rail: "airwallex_transfer",
      currency: "EUR",
    },
  ],
  orders: [],
};

/** The review the engine built for that run (apps/engine/src/treasury.ts). */
const review = (taskId: string): AgentTask => ({
  kind: "spend_review",
  role: "treasury",
  taskId,
  at: "2026-11-04T20:58:00.000Z",
  sourceRef: `src_${taskId.slice("task_".length)}`,
  content: "Scheduled spend review: how each agent's spending stands against its limits.",
  agents: [
    {
      role: "sourcing",
      warrantId: "wrt_sourcing",
      perPaymentCap: usdz(3),
      totalBudget: usdz(1000),
      spent: usdz(2),
    },
    {
      role: "support",
      warrantId: "wrt_support",
      perPaymentCap: usdz(400),
      totalBudget: usdz(400),
      spent: usdz(0),
    },
    {
      role: "treasury",
      warrantId: "wrt_treasury_sweep",
      perPaymentCap: usdz(600),
      totalBudget: usdz(600),
      spent: usdz(0),
    },
  ],
  totalLimit: usdz(2000),
  upstreamPrice: usdz(4),
});

describe("Haiku's spend review after the price rise (recorded, replayed)", () => {
  for (const taskId of ["task_review_1_3", "task_review_2_4", "task_review_3_5"]) {
    it(`${taskId}: one change, sourcing's per-payment limit to 4 cents, nothing else`, async () => {
      const changes: BudgetChangeProposal[] = [];
      const run = await runTask({
        brain: new ModelBrain({ create: replayCreate(fixtures) }),
        task: review(taskId),
        ctx: treasury,
        submit: () => Promise.reject(new Error("a review must not propose a payment")),
        submitLimits: (c): Promise<ProposalOutcome> => {
          changes.push(c);
          return Promise.resolve({ status: "owner" });
        },
        ids: counterIds("r"),
      });
      expect(run.error).toBeUndefined();
      expect(run.proposals).toEqual([]);
      expect(
        changes.map((c) => [c.warrantId, c.newPerPaymentCap, c.newTotalBudget, c.agentId]),
      ).toEqual([["wrt_sourcing", usdz(4), usdz(1000), "agt_treasury"]]);
    });
  }
});
