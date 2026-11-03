import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { z } from "zod";
import { AgentRole, DisputeClaim, Money, Recurrence } from "@warrant/contracts";
import type { AgentTask } from "@warrant/contracts";
import { LICENCE_FEE, UPSTREAM_PRICE_BEFORE } from "@warrant/control";

/**
 * One benchmark case, as stored in `bench/corpus/**.json`. Mirrors `schema/attack.schema.json`
 * (keep the two in step). The JSON schema is for editors; this is what the runner enforces.
 */

/** Families from the original schema plus the feed's (`packages/mocks/src/feed`). */
export const FAMILIES = [
  "price_rise",
  "payee_swap",
  "prompt_injection",
  "refund_fraud",
  "fake_invoice",
  "sneaky_recurring",
  "fake_price_notice",
  "hidden_instruction_invoice",
  "swapped_payee",
  "subscription_trap",
  "duplicate_charge",
  "budget_drain",
  "urgent_refund_social",
  "fx_rate_manipulation",
  "benign",
] as const;

export const BenchCase = z
  .object({
    id: z.string().regex(/^[a-z0-9-]+$/),
    family: z.enum(FAMILIES),
    agent: AgentRole,
    benign: z.boolean(),
    /** The engine world's warrant for this agent (wrt_sourcing, wrt_support, wrt_treasury). */
    warrantRef: z.string().min(1),
    setup: z
      .object({
        channel: z.enum([
          "x402_offer",
          "invoice",
          "support_ticket",
          "price_notice",
          "email",
          "fx_quote",
        ]),
        /** Untrusted text the agent reads. */
        content: z.string().max(4000),
        x402Requirements: z.record(z.string(), z.unknown()).optional(),
        /** The task's structured fields. Anything left out takes the default for the agent. */
        task: z
          .object({
            payeeId: z.string().min(1).optional(),
            item: z.string().min(1).optional(),
            price: Money.optional(),
            amount: Money.optional(),
            recurrence: Recurrence.optional(),
            orderIds: z.array(z.string().min(1)).min(1).max(500).optional(),
            claim: DisputeClaim.optional(),
          })
          .strict()
          .optional(),
        /**
         * Payments already made before the case (to the task's payee, not by the agent), so the
         * purpose check sees a history: price change, frequency, duplicates.
         */
        prior: z
          .array(
            z
              .object({
                cents: z.number().int().positive(),
                /** How long before the task it was paid. Default 60. */
                minutesBefore: z.number().int().min(1).max(120).optional(),
              })
              .strict(),
          )
          .max(50)
          .optional(),
      })
      .strict(),
    expected: z
      .object({
        moneyMoves: z.boolean(),
        /** Attacks only: cents that may move without counting as a miss (a legit part). */
        maxCents: z.number().int().min(0).optional(),
        /**
         * Attacks only, instead of `maxCents`: the genuine bill inside the attack. One-off
         * payments to `payeeId` up to `amount` are not a miss; anything else paid is (SCORING.md).
         */
        legit: z
          .object({ payeeId: z.string().min(1), amount: Money })
          .strict()
          .optional(),
        blockedBy: z.enum(["rules", "purpose", "owner", "any"]).optional(),
      })
      .strict(),
    notes: z.string().optional(),
  })
  .strict();
export type BenchCase = z.infer<typeof BenchCase> & { heldout?: boolean; file?: string };

const WARRANTS: Record<AgentRole, string> = {
  sourcing: "wrt_sourcing",
  support: "wrt_support",
  treasury: "wrt_treasury",
};

/** Load and validate every case under `dir`. Throws one error listing every bad file. */
export function loadCorpus(dir: string): BenchCase[] {
  const files = walk(dir).filter((f) => f.endsWith(".json"));
  const cases: BenchCase[] = [];
  const problems: string[] = [];
  const ids = new Set<string>();
  for (const file of files) {
    const rel = relative(dir, file).split(sep).join("/");
    let raw: unknown;
    try {
      raw = JSON.parse(readFileSync(file, "utf8"));
    } catch (e) {
      problems.push(`${rel}: not JSON (${(e as Error).message})`);
      continue;
    }
    const parsed = BenchCase.safeParse(raw);
    if (!parsed.success) {
      const why = parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`);
      problems.push(`${rel}: ${why.join("; ")}`);
      continue;
    }
    const c = parsed.data;
    if (ids.has(c.id)) problems.push(`${rel}: duplicate id ${c.id}`);
    if (c.warrantRef !== WARRANTS[c.agent]) {
      problems.push(`${rel}: warrantRef must be ${WARRANTS[c.agent]} for ${c.agent}`);
    }
    if ((c.family === "benign") !== c.benign) problems.push(`${rel}: family benign <=> benign`);
    if (c.benign !== c.expected.moneyMoves) problems.push(`${rel}: benign must match moneyMoves`);
    if (c.expected.legit) {
      if (c.benign) problems.push(`${rel}: legit is for attacks only`);
      if (c.expected.maxCents !== undefined)
        problems.push(`${rel}: use legit or maxCents, not both`);
      if (c.agent === "support") problems.push(`${rel}: legit is for payments, not refunds`);
    }
    ids.add(c.id);
    cases.push({ ...c, file: rel, heldout: rel.startsWith("heldout/") });
  }
  if (problems.length > 0) throw new Error(`bad corpus:\n  ${problems.join("\n  ")}`);
  return cases.sort((a, b) => a.id.localeCompare(b.id));
}

function walk(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const p = join(dir, name);
    return statSync(p).isDirectory() ? walk(p) : [p];
  });
}

/** The task the agent gets for a case. Same for every mode. */
export function caseToTask(c: BenchCase, at: Date): AgentTask {
  const t = c.setup.task ?? {};
  const base = {
    taskId: `task_${c.id}`,
    at: at.toISOString(),
    sourceRef: `src_${c.id}`,
    content: c.setup.content,
  };
  if (c.agent === "sourcing") {
    return {
      ...base,
      kind: "data_offer",
      role: "sourcing",
      payeeId: t.payeeId ?? "pay_upstream",
      item: t.item ?? "GET /forecast/eurusd",
      price: t.price ?? UPSTREAM_PRICE_BEFORE,
    };
  }
  if (c.agent === "support") {
    return {
      ...base,
      kind: "dispute",
      role: "support",
      disputeId: `dsp_${c.id}`,
      orderIds: t.orderIds ?? ["ord_1"],
      claim: t.claim ?? "wrong_data",
    };
  }
  return {
    ...base,
    kind: "invoice",
    role: "treasury",
    payeeId: t.payeeId ?? "pay_licensor",
    amount: t.amount ?? LICENCE_FEE,
    recurrence: t.recurrence ?? "one_off",
  };
}
