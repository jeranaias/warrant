import type Anthropic from "@anthropic-ai/sdk";
import { BudgetChangeProposal, Currency } from "@warrant/contracts";
import type { AgentTask } from "@warrant/contracts";
import type { AgentContext } from "./context.js";
import type { IdSource } from "./tool.js";

/**
 * Treasury's second tool (ADR-020): propose new limits for one agent's warrant after a spend
 * review. It moves no money. What it builds is a `BudgetChangeProposal`, which control checks
 * (within the 20 USDZ total, above what is already spent) and which always waits for the owner
 * (ADR-007); on approval the owner replaces the mandate and signs the next warrant version.
 *
 * The model picks the warrant (one from the task's list), the new total and, optionally, the new
 * per-payment limit. The runner fills the ids, the agent and the time.
 */
export const LIMITS_TOOL_NAME = "propose_limits";

/** What the model sends. Validated by `toBudgetChange`, never trusted as-is. */
export interface ProposeLimitsInput {
  warrantId: string;
  newTotalBudget: { currency: Currency; cents: number };
  newPerPaymentCap?: { currency: Currency; cents: number };
  justification: string;
}

const DESCRIPTION = `Propose new limits for one agent's warrant, from a spend review. This moves no money.
The owner always decides; control answers needs_owner_approval or blocked. A blocked or waiting
proposal is final for this task: do not retry it with other values. Use only a warrantId listed in
the spend review.`;

const money = {
  type: "object",
  additionalProperties: false,
  required: ["currency", "cents"],
  properties: {
    currency: { type: "string", enum: [...Currency.options] },
    cents: { type: "integer", minimum: 0, description: "Integer minor units." },
  },
} as const;

export function proposeLimitsTool(): Anthropic.Tool {
  return {
    name: LIMITS_TOOL_NAME,
    description: DESCRIPTION,
    input_schema: {
      type: "object",
      additionalProperties: false,
      required: ["warrantId", "newTotalBudget", "justification"],
      properties: {
        warrantId: { type: "string", description: "A warrantId from the spend review." },
        newTotalBudget: money,
        newPerPaymentCap: money,
        justification: {
          type: "string",
          description: "One sentence for the owner, who sees it next to the change.",
        },
      },
    },
  };
}

export type ToBudgetChangeResult =
  { ok: true; change: BudgetChangeProposal } | { ok: false; error: string };

/**
 * Turn the model's tool input into a `BudgetChangeProposal`. Only for a spend review, and only for
 * a warrant that review lists. The runner's fields win over anything the model sent.
 */
export function toBudgetChange(
  input: unknown,
  task: AgentTask,
  ctx: AgentContext,
  ids: IdSource,
  now: Date,
): ToBudgetChangeResult {
  if (task.kind !== "spend_review") {
    return { ok: false, error: `${LIMITS_TOOL_NAME} is only for a spend review` };
  }
  const i = (input && typeof input === "object" ? input : {}) as Record<string, unknown>;
  const warrantId = i["warrantId"];
  if (typeof warrantId !== "string" || !task.agents.some((a) => a.warrantId === warrantId)) {
    return { ok: false, error: `invalid ${LIMITS_TOOL_NAME} input (warrantId not in the review)` };
  }
  const cap = i["newPerPaymentCap"];
  const parsed = BudgetChangeProposal.safeParse({
    proposalId: ids.proposalId(),
    warrantId,
    agentId: ctx.agentId,
    newTotalBudget: i["newTotalBudget"],
    ...(cap === undefined || cap === null ? {} : { newPerPaymentCap: cap }),
    justification: String(i["justification"] ?? "").slice(0, 2000),
    createdAt: now.toISOString(),
  });
  if (!parsed.success) {
    const where = parsed.error.issues.map((x) => x.path.join(".") || "input").join(", ");
    return { ok: false, error: `invalid ${LIMITS_TOOL_NAME} input (${where})` };
  }
  return { ok: true, change: parsed.data };
}
