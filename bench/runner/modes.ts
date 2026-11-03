import type { Server } from "node:http";
import type { AgentTask, PaymentProposal, SignedOrderRecord } from "@warrant/contracts";
import { EngineClient } from "@warrant/agents";
import type { ProposalOutcome, Submit, WorldView } from "@warrant/agents";
import { Ledger, checkRules, verifyWarrant } from "@warrant/control";
import type { PurposeChecker, RulesContext } from "@warrant/control";
import { answerDispute, createEngine, fileDispute } from "@warrant/engine";
import type { Engine } from "@warrant/engine";
import type { BenchCase } from "./case.js";

/**
 * The three configurations of SCORING.md. Each case gets a fresh, isolated world: the engine's
 * signed warrants, stored orders and mock rails, made new for that case only.
 *
 * - `unprotected`: nothing between the agent and the rail. Every well-formed proposal is paid.
 * - `limits_only`: the rules check only (payee list, cap, budget, expiry, duplicate guard, refund
 *   matches order), in code, with its own ledger. No purpose check, no owner.
 * - `warrant`: the full engine over HTTP (`POST /proposals`): rules + purpose + owner + ledger +
 *   mock rails.
 */
export const MODES = ["unprotected", "limits_only", "warrant"] as const;
export type ModeName = (typeof MODES)[number];

/** Bench time. Each case starts at the same instant so runs are reproducible. */
export const START = new Date("2026-11-01T12:00:00Z");

export interface ModeRun {
  world: WorldView;
  submit: Submit;
  /** The case's clock (priors happen before START). */
  clock: () => Date;
  close: () => Promise<void>;
}

/** Start one mode for one case, with the case's prior payments already made. */
export async function startMode(
  mode: ModeName,
  c: BenchCase,
  task: AgentTask,
  purpose: PurposeChecker,
): Promise<ModeRun> {
  // Warrants are signed "now" with notBefore a minute earlier, so start before the priors.
  let now = new Date(START.getTime() - 3 * 60 * 60_000);
  const clock = () => now;
  const engine = createEngine({ scenario: "none", purpose, clock });
  const server = engine.app.listen(0, "127.0.0.1");
  await new Promise<void>((ok) => server.once("listening", () => ok()));
  const client = new EngineClient(baseUrl(server));
  const close = () => new Promise<void>((ok) => server.close(() => ok()));
  const world = await client.world();
  // The store has the customer's dispute on file, as the engine does for tasks it hands out.
  fileDispute(engine.disputes, task);

  const submit: Submit =
    mode === "unprotected"
      ? () => out({ status: "paid" })
      : mode === "limits_only"
        ? limitsOnly(engine, clock)
        : client.submit;

  // Prior history, through the same mode (it is "what already happened" for this world).
  const priors = c.setup.prior ?? [];
  for (const [i, p] of priors.entries()) {
    now = new Date(START.getTime() - (p.minutesBefore ?? 60) * 60_000);
    if (task.kind === "data_offer") engine.world.upstream.setPrice(p.cents);
    await submit(priorProposal(c, task, i, p.cents, now));
  }
  now = START;
  // The store decides the dispute from its records as support picks it up (ADR-021).
  if (task.kind === "dispute") {
    await answerDispute(
      { world: engine.world, controller: engine.controller, decisions: engine.decisions },
      {
        disputeId: task.disputeId,
        orderIds: task.orderIds,
        claim: task.claim,
        ticketRef: task.sourceRef,
      },
      now,
    );
  }
  // The seller charges what its offer says (the rail refuses any other amount).
  if (task.kind === "data_offer" && task.price.cents > 0) {
    engine.world.upstream.setPrice(task.price.cents);
  }
  return { world, submit, clock, close };
}

const out = (o: ProposalOutcome): Promise<ProposalOutcome> => Promise.resolve(o);

function baseUrl(server: Server): string {
  const a = server.address();
  return `http://127.0.0.1:${typeof a === "object" && a ? a.port : 0}`;
}

/** A routine payment to the task's payee, as it would have happened before the case. */
function priorProposal(
  c: BenchCase,
  task: AgentTask,
  i: number,
  cents: number,
  at: Date,
): PaymentProposal {
  const role = c.agent;
  const common = {
    proposalId: `prop_prior_${c.id}_${i}`,
    warrantId: c.warrantRef,
    agentId: `agt_${role}`,
    agentRole: role,
    recurrence: "one_off" as const,
    idempotencyKey: `idem-prior-${c.id}-${i}`,
    justification: "bench: prior payment",
    createdAt: at.toISOString(),
  };
  if (task.kind === "data_offer") {
    return {
      ...common,
      rail: "metal_x402",
      payeeId: task.payeeId,
      amount: { currency: task.price.currency, cents },
      category: "data_purchase",
    };
  }
  if (task.kind === "dispute") {
    return {
      ...common,
      rail: "metal_x402",
      payeeId: "customer",
      amount: { currency: "USDZ", cents },
      category: "customer_refund",
      refundOfOrderId: task.orderIds[i % task.orderIds.length] ?? "ord_1",
      sourceRef: task.sourceRef,
    };
  }
  // Bench cases only make invoice tasks for treasury (case.ts).
  if (task.kind !== "invoice") throw new Error(`bench: no prior payments for ${task.kind} tasks`);
  return {
    ...common,
    rail: "airwallex_transfer",
    payeeId: task.payeeId,
    amount: { currency: task.amount.currency, cents },
    category: "licence_fee",
  };
}

/** Rules in code, nothing else: the "limits only" configuration. */
function limitsOnly(engine: Engine, clock: () => Date): Submit {
  const { world } = engine;
  const ledger = new Ledger(undefined, clock);
  return (p) => {
    const w = world.warrants.get(p.warrantId);
    if (!w) return out({ status: "blocked", blockedBy: "rules", detail: "no warrant" });
    const ctx: RulesContext = {
      now: clock(),
      signatureValid: verifyWarrant(w, world.ownerPublicKey),
      killSwitchEngaged: false,
      committedCents: ledger.committedCents(w.warrantId),
      seenIdempotencyKeys: ledger.idempotencyKeys(),
      recentPayments: ledger.activeReservations(w.warrantId).map((r) => ({
        payeeId: r.payeeId ?? "",
        rail: r.rail,
        cents: r.amount.cents,
        at: new Date(r.reservedAt),
        ...(r.sourceRef ? { sourceRef: r.sourceRef } : {}),
      })),
      orders: world.orders(),
      refundedOrderIds: refunded(ledger, w.warrantId, world.orders()),
      disputes: engine.disputes,
      decisions: engine.decisions,
    };
    const rules = checkRules(w, p, ctx);
    if (!rules.pass) {
      const failed = rules.checks.filter((x) => !x.pass).map((x) => x.rule);
      return out({ status: "blocked", blockedBy: "rules", detail: failed.join(", ") });
    }
    const r = ledger.reserve({
      proposalId: p.proposalId,
      warrantId: w.warrantId,
      rail: p.rail,
      amount: p.amount,
      idempotencyKey: p.idempotencyKey,
      payeeId: p.refundOfOrderId ?? p.payeeId,
      ...(p.sourceRef ? { sourceRef: p.sourceRef } : {}),
    });
    ledger.confirm(r.reservationId);
    return out({ status: "paid" });
  };
}

function refunded(
  ledger: Ledger,
  warrantId: string,
  orders: ReadonlyMap<string, SignedOrderRecord>,
): ReadonlySet<string> {
  return new Set(
    ledger
      .activeReservations(warrantId)
      .map((r) => r.payeeId ?? "")
      .filter((id) => orders.has(id)),
  );
}
