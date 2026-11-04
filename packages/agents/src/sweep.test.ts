import type Anthropic from "@anthropic-ai/sdk";
import { describe, expect, it } from "vitest";
import type { AgentTask, PaymentProposal } from "@warrant/contracts";
import { contextFor, warrantFor } from "./context.js";
import type { WorldView } from "./context.js";
import { ModelBrain } from "./model.js";
import type { CreateMessage } from "./model.js";
import { renderTask } from "./prompts.js";
import { replayCreate } from "./replay.js";
import { runTask } from "./runner.js";
import type { ProposalOutcome } from "./runner.js";
import { ScriptedBrain } from "./scripted.js";
import { counterIds } from "./tool.js";

/**
 * Treasury's sweep (ADR-022) as the agent sees it. The sweep runs under its own warrant, so the
 * model must be shown that warrant (Metal, our treasury payee), not the licence warrant.
 */

const NOW = new Date("2026-11-04T12:00:00Z");

const licence = {
  warrantId: "wrt_treasury",
  agentId: "agt_treasury",
  agentRole: "treasury" as const,
  purpose: "Pay the monthly data licence fee in euros.",
  allowedRails: ["airwallex_transfer" as const],
  payees: [
    {
      payeeId: "pay_licensor",
      displayName: "Data licensor (EUR)",
      rail: "airwallex_transfer" as const,
      currency: "EUR" as const,
    },
  ],
};
const sweepWarrant = {
  warrantId: "wrt_treasury_sweep",
  agentId: "agt_treasury",
  agentRole: "treasury" as const,
  purpose: "Move the store's earnings to our own treasury address, then to Airwallex.",
  allowedRails: ["metal_x402" as const],
  payees: [
    {
      payeeId: "pay_treasury",
      displayName: "Our treasury (to Airwallex)",
      rail: "metal_x402" as const,
      currency: "USDZ" as const,
    },
  ],
};

/** The engine's GET /world shape, with or without the sweep warrant. */
function world(withSweep: boolean): WorldView {
  const ids = (role: "sourcing" | "support") => ({
    role,
    agentId: `agt_${role}`,
    warrantId: `wrt_${role}`,
  });
  const plain = (role: "sourcing" | "support") => ({
    warrantId: `wrt_${role}`,
    agentId: `agt_${role}`,
    agentRole: role,
    purpose: role,
    allowedRails: ["metal_x402" as const],
    payees: [],
  });
  return {
    agents: {
      sourcing: ids("sourcing"),
      support: ids("support"),
      treasury: {
        role: "treasury",
        agentId: "agt_treasury",
        warrantId: "wrt_treasury",
        ...(withSweep ? { sweepWarrantId: "wrt_treasury_sweep" } : {}),
      },
    },
    warrants: [plain("sourcing"), plain("support"), licence, ...(withSweep ? [sweepWarrant] : [])],
    orders: [],
  };
}

const sweepTask: AgentTask = {
  kind: "sweep",
  role: "treasury",
  taskId: "task_sweep_1",
  at: NOW.toISOString(),
  sourceRef: "src_sweep_1",
  payeeId: "pay_treasury",
  available: { currency: "USDZ", cents: 15 },
  content: "Today's store earnings are ready to move to Airwallex.",
};
const invoiceTask: AgentTask = {
  kind: "invoice",
  role: "treasury",
  taskId: "task_inv_1",
  at: NOW.toISOString(),
  sourceRef: "src_inv_1",
  payeeId: "pay_licensor",
  amount: { currency: "EUR", cents: 5000 },
  recurrence: "one_off",
  content: "Invoice INV-1107: monthly data licence, EUR 50.00.",
};

/** The JSON block the model gets under "Your warrant:". */
const shownWarrant = (text: string) =>
  JSON.parse(/Your warrant:\n([\s\S]*?)\n\nTask:/.exec(text)?.[1] ?? "{}") as {
    warrantId: string;
    allowedRails: string[];
    payees: { payeeId: string }[];
  };

function paysAll() {
  const seen: PaymentProposal[] = [];
  return {
    seen,
    submit: (p: PaymentProposal): Promise<ProposalOutcome> => {
      seen.push(p);
      return Promise.resolve({ status: "owner" });
    },
  };
}

describe("treasury's sweep context (ADR-022)", () => {
  it("the context carries the sweep warrant the world publishes", () => {
    const ctx = contextFor(world(true), "treasury");
    expect(ctx.warrantId).toBe("wrt_treasury");
    expect(ctx.sweepWarrantId).toBe("wrt_treasury_sweep");
    expect(ctx.sweep).toEqual({
      warrantId: "wrt_treasury_sweep",
      purpose: sweepWarrant.purpose,
      allowedRails: ["metal_x402"],
      payees: sweepWarrant.payees,
    });
  });

  it("a sweep is shown the sweep warrant: Metal, our treasury payee, not the licensor", () => {
    const shown = shownWarrant(renderTask(sweepTask, contextFor(world(true), "treasury")));
    expect(shown.warrantId).toBe("wrt_treasury_sweep");
    expect(shown.allowedRails).toEqual(["metal_x402"]);
    expect(shown.payees.map((p) => p.payeeId)).toEqual(["pay_treasury"]);
  });

  it("an invoice is still shown the licence warrant", () => {
    const shown = shownWarrant(renderTask(invoiceTask, contextFor(world(true), "treasury")));
    expect(shown.warrantId).toBe("wrt_treasury");
    expect(shown.payees.map((p) => p.payeeId)).toEqual(["pay_licensor"]);
  });

  it("the warrant shown is the warrant proposed under, for every treasury task", async () => {
    const ctx = contextFor(world(true), "treasury");
    for (const task of [sweepTask, invoiceTask]) {
      const { seen, submit } = paysAll();
      await runTask({ brain: new ScriptedBrain(), task, ctx, submit, ids: counterIds("s") });
      expect(seen.map((p) => p.warrantId)).toEqual([warrantFor(task, ctx).warrantId]);
      expect(shownWarrant(renderTask(task, ctx)).warrantId).toBe(warrantFor(task, ctx).warrantId);
    }
  });

  it("without a sweep warrant a sweep falls back to the licence warrant (the rules refuse it)", async () => {
    const ctx = contextFor(world(false), "treasury");
    expect(ctx.sweep).toBeUndefined();
    expect(warrantFor(sweepTask, ctx).warrantId).toBe("wrt_treasury");
    const { seen, submit } = paysAll();
    await runTask({
      brain: new ScriptedBrain(),
      task: sweepTask,
      ctx,
      submit,
      ids: counterIds("s"),
    });
    expect(seen.map((p) => p.warrantId)).toEqual(["wrt_treasury"]);
  });

  it("the model (replayed) is shown the sweep warrant and its sweep goes under it", async () => {
    const requests: Anthropic.MessageCreateParamsNonStreaming[] = [];
    const msg = (content: Anthropic.ContentBlock[], stop: "tool_use" | "end_turn") =>
      ({
        id: `msg_sweep_${requests.length}`,
        type: "message",
        role: "assistant",
        model: "claude-haiku-4-5",
        content,
        stop_reason: stop,
        stop_sequence: null,
        usage: { input_tokens: 900, output_tokens: 60 },
      }) as Anthropic.Message;
    const inner = replayCreate({
      "treasury/task_sweep_1/1": msg(
        [
          {
            type: "tool_use",
            id: "toolu_sweep_1",
            name: "propose_payment",
            input: {
              rail: "metal_x402",
              payeeId: "pay_treasury",
              amount: { currency: "USDZ", cents: 15 },
              category: "treasury_sweep",
              recurrence: "one_off",
              justification: "move today's earnings to our treasury",
            },
          } as Anthropic.ToolUseBlock,
        ],
        "tool_use",
      ),
      "treasury/task_sweep_1/2": msg(
        [{ type: "text", text: "Proposed; the owner approves.", citations: null }],
        "end_turn",
      ),
    });
    const create: CreateMessage = (params, key) => {
      requests.push(structuredClone(params));
      return inner(params, key);
    };
    const { seen, submit } = paysAll();
    const run = await runTask({
      brain: new ModelBrain({ create }),
      task: sweepTask,
      ctx: contextFor(world(true), "treasury"),
      submit,
      ids: counterIds("m"),
      clock: () => NOW,
    });
    expect(run.error).toBeUndefined();
    const firstTurn = requests[0]?.messages[0]?.content;
    expect(typeof firstTurn === "string" && shownWarrant(firstTurn).warrantId).toBe(
      "wrt_treasury_sweep",
    );
    expect(seen.map((p) => [p.warrantId, p.rail, p.payeeId, p.category])).toEqual([
      ["wrt_treasury_sweep", "metal_x402", "pay_treasury", "treasury_sweep"],
    ]);
  });
});
