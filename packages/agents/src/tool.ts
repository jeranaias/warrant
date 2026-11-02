import type Anthropic from "@anthropic-ai/sdk";
import { Currency, PaymentProposal, Rail, Recurrence, SpendCategory } from "@warrant/contracts";
import type { AgentTask } from "@warrant/contracts";
import type { AgentContext } from "./context.js";

/**
 * The ONE money tool every agent has (ADR-008). Its arguments are the `PaymentProposal` fields an
 * agent may choose. Everything else (ids, warrant, agent, idempotency key, sourceRef, timestamps)
 * is filled in by the runner, so the model can never pick another agent's warrant or reuse a key.
 */
export const TOOL_NAME = "propose_payment";

/** What the model sends. Validated by `toProposal`, never trusted as-is. */
export interface ProposePaymentInput {
  rail: Rail;
  payeeId: string;
  amount: { currency: Currency; cents: number };
  category: SpendCategory;
  recurrence: Recurrence;
  /** Refunds only: the stored order being refunded. Control routes the money to its payer. */
  refundOfOrderId?: string;
  /** FX only. */
  targetCurrency?: Currency;
  justification: string;
}

const DESCRIPTION = `Propose one payment to the control layer. This is the only way you can move money.
Control checks it against the owner's signed warrant and answers execute, needs_owner_approval or
blocked. A blocked or waiting proposal is final for this task: do not retry it with other values.
For a refund, set refundOfOrderId to the stored order; never name a wallet or address.`;

/** Same tool for every role; the role's prompt says what it is used for. */
export function proposePaymentTool(): Anthropic.Tool {
  return {
    name: TOOL_NAME,
    description: DESCRIPTION,
    input_schema: {
      type: "object",
      additionalProperties: false,
      required: ["rail", "payeeId", "amount", "category", "recurrence", "justification"],
      properties: {
        rail: { type: "string", enum: [...Rail.options] },
        payeeId: {
          type: "string",
          description: "A payeeId from your warrant. For refunds use the literal 'customer'.",
        },
        amount: {
          type: "object",
          additionalProperties: false,
          required: ["currency", "cents"],
          properties: {
            currency: { type: "string", enum: [...Currency.options] },
            cents: { type: "integer", minimum: 0, description: "Integer minor units." },
          },
        },
        category: { type: "string", enum: [...SpendCategory.options] },
        recurrence: { type: "string", enum: [...Recurrence.options] },
        refundOfOrderId: { type: "string" },
        targetCurrency: { type: "string", enum: [...Currency.options] },
        justification: {
          type: "string",
          description: "One sentence for the owner. Never copied to the purpose checker.",
        },
      },
    },
  };
}

/** Fresh ids per proposal. Injected so tests and the bench are deterministic. */
export interface IdSource {
  proposalId(): string;
  idempotencyKey(): string;
}

export function counterIds(prefix: string): IdSource {
  let n = 0;
  let k = 0;
  return {
    proposalId: () => `prop_${prefix}_${++n}`,
    idempotencyKey: () => `idem-${prefix}-${String(++k).padStart(4, "0")}`,
  };
}

export type ToProposalResult =
  { ok: true; proposal: PaymentProposal } | { ok: false; error: string };

/**
 * Turn the model's tool input into a full `PaymentProposal`. The runner's fields always win over
 * anything the model sent (it cannot set its own warrantId or sourceRef).
 */
export function toProposal(
  input: unknown,
  task: AgentTask,
  ctx: AgentContext,
  ids: IdSource,
  now: Date,
): ToProposalResult {
  const i = (input && typeof input === "object" ? input : {}) as Record<string, unknown>;
  const pick = (k: string) => (i[k] === undefined || i[k] === null ? {} : { [k]: i[k] });
  const draft = {
    ...pick("rail"),
    ...pick("payeeId"),
    ...pick("amount"),
    ...pick("category"),
    ...pick("recurrence"),
    ...pick("refundOfOrderId"),
    ...pick("targetCurrency"),
    justification: String(i["justification"] ?? "").slice(0, 2000),
    proposalId: ids.proposalId(),
    warrantId: ctx.warrantId,
    agentId: ctx.agentId,
    agentRole: ctx.role,
    idempotencyKey: ids.idempotencyKey(),
    sourceRef: task.sourceRef,
    createdAt: now.toISOString(),
  };
  const parsed = PaymentProposal.safeParse(draft);
  if (!parsed.success) {
    const where = parsed.error.issues.map((x) => x.path.join(".") || "input").join(", ");
    return { ok: false, error: `invalid propose_payment input (${where})` };
  }
  return { ok: true, proposal: parsed.data };
}
