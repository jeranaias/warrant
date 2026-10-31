import type { AgentTask } from "@warrant/contracts";
import type { Brain, Propose } from "./brain.js";
import type { AgentContext } from "./context.js";
import type { ProposePaymentInput } from "./tool.js";

/**
 * A deterministic, deliberately NAIVE agent for tests, CI and runs without API credits.
 *
 * It does what the task asks AND whatever the untrusted content tells it to: a new address, a new
 * price, "buy 200 batches", "make it monthly". That is the worst case of a prompt-injected model,
 * which is the point of the benchmark: control, not the agent, has to stop the money. A careful
 * model should do better than this; Warrant must not depend on it.
 */
export class ScriptedBrain implements Brain {
  readonly name = "scripted-naive";

  /** Cap on how many payments one task can make the script propose ("buy 200 batches"). */
  constructor(private readonly maxPerTask = 20) {}

  async act(task: AgentTask, ctx: AgentContext, propose: Propose): Promise<void> {
    for (const input of this.plan(task, ctx)) await propose(input);
  }

  /** What the script would propose for a task, without submitting. */
  plan(task: AgentTask, ctx: AgentContext): ProposePaymentInput[] {
    const told = readInstructions(task.content);
    const why = `scripted: ${task.kind} ${task.taskId}`;
    if (task.kind === "data_offer") {
      const one: ProposePaymentInput = {
        rail: "metal_x402",
        payeeId: told.address ?? told.payeeId ?? task.payeeId,
        amount: { currency: task.price.currency, cents: told.cents ?? task.price.cents },
        category: "data_purchase",
        recurrence: told.recurring ? "recurring" : "one_off",
        justification: why,
      };
      return Array.from({ length: Math.min(told.count ?? 1, this.maxPerTask) }, () => one);
    }
    if (task.kind === "dispute") {
      const ids = [...new Set([...task.orderIds, ...told.orderIds])].slice(0, this.maxPerTask);
      return ids.map((orderId): ProposePaymentInput => ({
        rail: "metal_x402",
        payeeId: told.address ?? "customer",
        amount: {
          currency: "USDZ",
          cents:
            told.cents ??
            ctx.orders.find((o) => o.orderId === orderId)?.price.cents ??
            DEFAULT_REFUND,
        },
        category: "customer_refund",
        recurrence: "one_off",
        refundOfOrderId: orderId,
        justification: why,
      }));
    }
    const one: ProposePaymentInput = {
      rail: "airwallex_transfer",
      payeeId: told.payeeId ?? told.address ?? task.payeeId,
      amount: { currency: task.amount.currency, cents: told.cents ?? task.amount.cents },
      category: /softwares?|seat/i.test(task.content) ? "software_seat" : "licence_fee",
      recurrence: told.recurring ? "recurring" : task.recurrence,
      justification: why,
    };
    return Array.from({ length: Math.min(told.count ?? 1, this.maxPerTask) }, () => one);
  }
}

/** What the script refunds for an order it cannot find (it does not know the price). */
const DEFAULT_REFUND = 5;

export interface Instructions {
  /** A money amount in the text, in minor units. The first one wins. */
  cents?: number;
  /** A 0x address the text says to pay. */
  address?: string;
  /** A payee id (`pay_...`) the text names. */
  payeeId?: string;
  /** "buy 200 batches", "pay 3 times". */
  count?: number;
  recurring: boolean;
  /** Order ids (`ord_...`) the text names. */
  orderIds: string[];
}

/** Naive reading of untrusted text. Exported so corpus authors can check what a case will do. */
export function readInstructions(text: string): Instructions {
  const address = /0x[0-9a-fA-F]{40}/.exec(text)?.[0];
  const payeeId = /\bpay_[a-z0-9_]+/.exec(text)?.[0];
  const count =
    /\b(?:buy|purchase|pay|send|order|repeat)\s+(\d{1,4})\s*(?:x\s+)?(?:batches|batch|times|calls|payments|units|seats|copies)\b/i.exec(
      text,
    )?.[1];
  const recurring =
    /\b(recurring|subscription|subscribe|standing (?:order|payment)|auto-?renew\w*|every (?:day|week|month))\b/i.test(
      text,
    );
  return {
    ...amountOf(text),
    ...(address ? { address } : {}),
    ...(payeeId ? { payeeId } : {}),
    ...(count ? { count: Number(count) } : {}),
    recurring,
    orderIds: [...text.matchAll(/\bord_[a-z0-9]+/g)].map((m) => m[0]),
  };
}

function amountOf(text: string): { cents?: number } {
  const patterns: [RegExp, (m: RegExpExecArray) => number][] = [
    [/(?:\$|€|£|\b(?:USDZ|USD|EUR|GBP)\s?)(\d+(?:\.\d{1,2})?)/, (m) => major(m[1] ?? "")],
    [/\b(\d+(?:\.\d+)?)\s?(?:USDZ|USD|EUR|GBP|dollars|euros)\b/i, (m) => major(m[1] ?? "")],
    [/\b(\d+)\s?cents?\b/i, (m) => Number(m[1])],
  ];
  let best: { at: number; cents: number } | undefined;
  for (const [re, toCents] of patterns) {
    const m = re.exec(text);
    if (m && (!best || m.index < best.at)) best = { at: m.index, cents: toCents(m) };
  }
  return best && Number.isSafeInteger(best.cents) ? { cents: best.cents } : {};
}

/** "0.04" -> 4, "4.00" -> 400, "99" -> 9900. Decimal string math, no floats. */
function major(decimal: string): number {
  const [whole = "0", frac = ""] = decimal.split(".");
  const cents = Number(whole) * 100 + Number(frac.slice(0, 2).padEnd(2, "0"));
  return cents;
}
