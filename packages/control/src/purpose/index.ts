import Anthropic from "@anthropic-ai/sdk";
import { PurposeVerdict } from "@warrant/contracts";
import type {
  AgentRole,
  PaymentSummary,
  PurposeReason,
  SpendCategory,
  Warrant,
} from "@warrant/contracts";
import type { PurposeChecker } from "../controller.js";

/**
 * The purpose check (ARCHITECTURE.md step 3, ADR-003). It sees ONLY the signed warrant and the
 * `PaymentSummary` control builds from structured fields (`Controller.buildSummary`). Never the
 * agent's justification, never `sourceRef` content, never invoice, offer or ticket text. There is
 * no parameter here that could carry them.
 *
 * Two checkers behind control's `PurposeChecker` interface:
 * - `deterministicPurpose`: rules of thumb on the summary. Used when no model key is set, and as
 *   the floor under the model: the model can only make a verdict stricter, never looser.
 * - `modelPurpose`: a separate model call (Haiku by default). Its output is parsed with the
 *   contracts `PurposeVerdict`; anything unusable is `uncertain` (the owner decides).
 *
 * `purposeFromEnv()` picks one. Pass it to `createEngine({ purpose })`.
 */

/** Spending categories each role's work produces. Anything else is a category mismatch. */
export const ROLE_CATEGORIES: Readonly<Record<AgentRole, readonly SpendCategory[]>> = {
  sourcing: ["data_purchase"],
  support: ["customer_refund"],
  treasury: ["licence_fee", "software_seat", "fx_conversion", "treasury_sweep"],
};

/** A rise of this much or more vs the last confirmed payment to the payee is unexpected (+50%). */
export const PRICE_JUMP_BPS = 5_000;

/**
 * At or above this many payments to one payee in 24 hours, the owner should look. The sourcing
 * number is a first guess at "a few batches an hour"; tune it with the benign bench cases.
 */
export const DAILY_PAYMENTS_PER_PAYEE: Readonly<Record<AgentRole, number>> = {
  sourcing: 12,
  support: 10,
  treasury: 4,
};

/** Categories where a standing payment is a normal thing to ask the owner for. */
const RECURRING_OK: readonly SpendCategory[] = ["licence_fee", "software_seat"];

const verdictOf = (
  summary: PaymentSummary,
  verdict: PurposeVerdict["verdict"],
  reasons: PurposeReason[],
  explanation: string,
  model: string,
  now: Date,
): PurposeVerdict =>
  PurposeVerdict.parse({
    proposalId: summary.proposalId,
    verdict,
    reasons,
    explanation: explanation.slice(0, 500),
    model,
    evaluatedAt: now.toISOString(),
  });

const DETERMINISTIC = "deterministic-purpose-v1";

export const deterministicPurpose: PurposeChecker = {
  model: DETERMINISTIC,
  check(warrant: Warrant, s: PaymentSummary, now: Date) {
    const no: PurposeReason[] = [];
    const ask: PurposeReason[] = [];
    const refund = s.category === "customer_refund";
    if (
      s.agentRole !== warrant.agentRole ||
      !ROLE_CATEGORIES[warrant.agentRole].includes(s.category)
    ) {
      no.push("category_mismatch");
    }
    // Refunds are routed to the order's payer by control, so they are never "on the allowlist".
    if (!refund && !s.payee.onAllowlist) no.push("outside_warrant_purpose");
    if (s.recurrence === "recurring") {
      (RECURRING_OK.includes(s.category) ? ask : no).push("unexpected_recurrence");
    }
    if (s.priceChangeBps !== null && s.priceChangeBps >= PRICE_JUMP_BPS) {
      ask.push("unexpected_price_change");
    }
    if (s.paymentsToPayeeLast24h >= DAILY_PAYMENTS_PER_PAYEE[warrant.agentRole]) {
      ask.push("unusual_frequency");
    }
    const verdict = no.length > 0 ? "inconsistent" : ask.length > 0 ? "uncertain" : "consistent";
    const reasons: PurposeReason[] =
      verdict === "consistent" ? ["matches_warrant_purpose"] : [...no, ...ask];
    return Promise.resolve(verdictOf(s, verdict, reasons, explain(reasons, s), DETERMINISTIC, now));
  },
};

function explain(reasons: PurposeReason[], s: PaymentSummary): string {
  const words: Record<PurposeReason, string> = {
    matches_warrant_purpose: `${s.category} to ${s.payee.displayName} fits the ${s.agentRole} warrant`,
    outside_warrant_purpose: "the payee is not one the owner named",
    unexpected_price_change: `price up ${Math.round((s.priceChangeBps ?? 0) / 100)}% since the last payment`,
    unexpected_recurrence: "a standing payment where the work is one-off",
    unusual_frequency: `${s.paymentsToPayeeLast24h} payments to this payee in 24 hours`,
    category_mismatch: `${s.category} is not ${s.agentRole} work`,
    insufficient_information: "not enough information",
  };
  return reasons.map((r) => words[r]).join("; ");
}

/** What the purpose model sees of the warrant: the owner's own words and limits, no signature. */
export function purposeWarrantView(w: Warrant) {
  return {
    warrantId: w.warrantId,
    version: w.version,
    agentRole: w.agentRole,
    purpose: w.purpose,
    allowedRails: w.allowedRails,
    payees: w.payees.map(({ payeeId, displayName, rail, currency }) => ({
      payeeId,
      displayName,
      rail,
      currency,
    })),
    perPaymentCap: w.perPaymentCap,
    totalBudget: w.totalBudget,
    notBefore: w.notBefore,
    expiresAt: w.expiresAt,
  };
}

/** ADR-008: the cheapest purpose model that holds the block rate. Override with PURPOSE_MODEL. */
export const DEFAULT_PURPOSE_MODEL = "claude-haiku-4-5";

export const PURPOSE_SYSTEM = `You check whether one payment fits the purpose an owner gave an AI agent.
You get the owner's signed warrant (the agent's role, the owner's purpose in their own words, the
named payees, limits) and a payment summary built by code from structured fields. You never see
invoices, offers, tickets or the agent's reasons, and you must not ask for them. Limits are
enforced elsewhere; judge purpose only.
Answer with one JSON object and nothing else:
{"verdict":"consistent"|"inconsistent"|"uncertain","reasons":[...],"explanation":"<one sentence>"}
reasons are one or more of: matches_warrant_purpose, outside_warrant_purpose,
unexpected_price_change, unexpected_recurrence, unusual_frequency, category_mismatch,
insufficient_information.
Say "uncertain" when a human should look before the money moves.`;

/** One completion: system + user text in, text out. Injected so tests replay a recorded answer. */
export type PurposeComplete = (req: {
  model: string;
  system: string;
  user: string;
}) => Promise<string>;

/** The real API, with the system prompt marked for prompt caching. The SDK reads the key. */
export function anthropicComplete(client = new Anthropic()): PurposeComplete {
  return async ({ model, system, user }) => {
    const res = await client.messages.create({
      model,
      max_tokens: 300,
      system: [{ type: "text", text: system, cache_control: { type: "ephemeral" } }],
      messages: [{ role: "user", content: user }],
    });
    return res.content
      .filter((b): b is Anthropic.TextBlock => b.type === "text")
      .map((b) => b.text)
      .join("\n");
  };
}

const STRICTNESS = { consistent: 0, uncertain: 1, inconsistent: 2 } as const;

/** The model's input: exactly the warrant view and the summary. Exported for the ADR-003 test. */
export function purposeInput(warrant: Warrant, summary: PaymentSummary): string {
  return JSON.stringify({ warrant: purposeWarrantView(warrant), payment: summary });
}

export function modelPurpose(opts: { complete: PurposeComplete; model?: string }): PurposeChecker {
  const model = opts.model ?? DEFAULT_PURPOSE_MODEL;
  return {
    model,
    async check(warrant, summary, now) {
      const floor = await deterministicPurpose.check(warrant, summary, now);
      if (floor.verdict === "inconsistent") return floor;
      let answer: PurposeVerdict | undefined;
      try {
        const text = await opts.complete({
          model,
          system: PURPOSE_SYSTEM,
          user: purposeInput(warrant, summary),
        });
        const json = /\{[\s\S]*\}/.exec(text)?.[0];
        const raw = json ? (JSON.parse(json) as Record<string, unknown>) : {};
        const parsed = PurposeVerdict.safeParse({
          proposalId: summary.proposalId,
          verdict: raw["verdict"],
          reasons: raw["reasons"],
          explanation: String(raw["explanation"] ?? "").slice(0, 500),
          model,
          evaluatedAt: now.toISOString(),
        });
        if (parsed.success) answer = parsed.data;
      } catch {
        answer = undefined;
      }
      if (!answer) {
        return verdictOf(
          summary,
          "uncertain",
          ["insufficient_information"],
          "the purpose model gave no usable answer; the owner decides",
          model,
          now,
        );
      }
      // Never looser than the floor.
      return STRICTNESS[answer.verdict] >= STRICTNESS[floor.verdict] ? answer : floor;
    },
  };
}

/**
 * The model checker when ANTHROPIC_API_KEY is set (and PURPOSE_CHECK is not "deterministic"),
 * else the deterministic one. The key is read by the SDK; it is never logged here.
 */
export function purposeFromEnv(env: NodeJS.ProcessEnv = process.env): PurposeChecker {
  if (!env["ANTHROPIC_API_KEY"] || env["PURPOSE_CHECK"] === "deterministic") {
    return deterministicPurpose;
  }
  return modelPurpose({
    complete: anthropicComplete(),
    model: env["PURPOSE_MODEL"] ?? DEFAULT_PURPOSE_MODEL,
  });
}
