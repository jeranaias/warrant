import { createHash, timingSafeEqual } from "node:crypto";
import express from "express";
import type { Express, NextFunction, Request, Response } from "express";
import { AgentRole, DisputeCase } from "@warrant/contracts";
import type { AgentTask } from "@warrant/contracts";
import { Controller, replay } from "@warrant/control";
import { classifyPay } from "@warrant/rails";
import type { ControlEvent, KillSwitchHooks, PurposeChecker } from "@warrant/control";
import { SCENARIOS, TaskFeed, scenario } from "@warrant/mocks/feed";
import type { ScenarioName } from "@warrant/mocks/feed";
import { answerDispute } from "./disputes.js";
import { spendReview } from "./treasury.js";
import { AGENTS, CUSTOMER_ADDRESS, OWNER_ID, makeWorld, placeholderPurpose } from "./world.js";
import type { World } from "./world.js";

/**
 * The engine: one local server that hands agents their work and runs what they propose through
 * control. Lane A's loop:
 *
 *   GET  /tasks?role=sourcing   -> tasks for that agent (offer, ticket, invoice)
 *   ...agent decides...
 *   POST /proposals             -> PaymentProposal in, control's decision out
 *   GET  /events                -> everything that happened, for the analyzer and the dashboard
 *   GET  /replay?proposalId=    -> one proposal step by step: rules, purpose, owner, ledger, rail
 *
 * Mock rails by default: nothing moves real money. With a sandbox world (`live.ts`,
 * RAILS_MODE=sandbox) the same routes run on the real Metal testnet.
 */

export interface EngineOptions {
  purpose?: PurposeChecker;
  /** Load this scenario at startup. */
  scenario?: ScenarioName | "none";
  clock?: () => Date;
  /** The world to run in; default a fresh mock world. */
  world?: World;
  /**
   * The owner's key. When set, the owner's actions (answering approvals, the emergency stop, and
   * the scenario/review/price/limits-only triggers) need `Authorization: Bearer <key>`; reading
   * stays open. `pnpm engine` always sets one.
   */
  ownerToken?: string;
}

interface LoggedEvent {
  seq: number;
  at: string;
  event: ControlEvent;
}

export interface Engine {
  app: Express;
  controller: Controller;
  world: World;
  /**
   * Disputes the store has on file, by `ticketRef`. A refund may only cover the orders of the
   * dispute its `sourceRef` names, whatever the ticket text adds.
   */
  disputes: Map<string, DisputeCase>;
  /** The store's verified refund per order, by `ticketRef`: control caps refunds at it (ADR-021). */
  decisions: Map<string, ReadonlyMap<string, number>>;
  /** Adds an event to GET /events (the store's pass checks and dispute answers). */
  record: (event: ControlEvent) => void;
}

/** What the emergency stop does outside control: revoke mandates, and freeze cards if any. */
export function killHooks(world: World): KillSwitchHooks {
  return {
    revokeMandates: world.revokeMandates,
    ...(world.freezeCards ? { freezeCards: world.freezeCards } : {}),
  };
}

export function createEngine(opts: EngineOptions = {}): Engine {
  const clock = opts.clock ?? (() => new Date());
  const world = opts.world ?? makeWorld(clock());
  const feed = new TaskFeed();
  const log: LoggedEvent[] = [];
  const disputes = new Map<string, DisputeCase>();
  const decisions = new Map<string, ReadonlyMap<string, number>>();
  const record = (event: ControlEvent) =>
    void log.push({ seq: log.length + 1, at: clock().toISOString(), event });

  const controller = new Controller({
    ownerPublicKey: world.ownerPublicKey,
    getWarrant: (id) => world.warrants.get(id),
    rails: world.rails,
    purpose: opts.purpose ?? placeholderPurpose,
    orders: world.orders,
    disputes: () => disputes,
    decisions: () => decisions,
    credentialFor: (w) => world.credentials.get(w.agentRole),
    applyBudgetChange: world.applyBudgetChange,
    budgetCheck: world.budgetCheck,
    clock,
    onEvent: record,
  });
  // Sandbox: our store's warrant pass checks, as they happen.
  world.watch?.(record);

  const initial = opts.scenario ?? (world.mode === "sandbox" ? "none" : "all");
  if (initial !== "none") feed.load(scenario(initial, clock()));

  const app = express();
  app.disable("x-powered-by");
  app.use((req, res, next) => {
    if (req.method === "GET" || req.method === "HEAD" || !crossSite(req)) return next();
    res.status(403).json({ error: "cross-site request refused" });
  });
  app.use(express.json({ limit: "100kb" }));
  const owner = ownerOnly(opts.ownerToken);

  app.get("/health", (_req, res) => {
    res.json({ ok: true, purposeModel: controller.purposeModel, queued: feed.pending().length });
  });

  // Who the agents are and what they may pay. Agents use these ids in their proposals.
  app.get("/world", (_req, res) => {
    res.json({
      ownerId: OWNER_ID,
      agents: AGENTS,
      warrants: [...world.warrants.values()].map((w) => ({
        warrantId: w.warrantId,
        version: w.version,
        agentId: w.agentId,
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
        spentCents: controller.ledger.spentCents(w.warrantId),
      })),
      orders: [...world.orders().values()].map(({ orderId, resource, price, at }) => ({
        orderId,
        resource,
        price,
        at,
      })),
    });
  });

  app.get("/scenarios", (_req, res) => {
    res.json({ scenarios: SCENARIOS });
  });

  // Replace the queue with a scenario's tasks.
  app.post("/scenario", owner, (req, res) => {
    const name = (req.body as { name?: string } | undefined)?.name;
    if (!SCENARIOS.includes(name as ScenarioName)) {
      res.status(400).json({ error: `name must be one of ${SCENARIOS.join(", ")}` });
      return;
    }
    feed.clear();
    const queued = feed.load(scenario(name as ScenarioName, clock()));
    // Mock world: buyers at our store's door first, so the seller's side of a warrant pass shows.
    // The customer's agent buys with its owner's pass; in the attacks, a buyer with none.
    if (world.storeSale) {
      if (name !== "attacks") record(world.storeSale(true));
      if (name === "attacks" || name === "all") record(world.storeSale(false));
    }
    res.json({ queued });
  });

  // Next tasks. Taking a task removes it from the queue. Labels stay server-side.
  app.get("/tasks", async (req, res) => {
    const role = roleOf(req);
    if (role === null) {
      res.status(400).json({ error: "role must be sourcing, support or treasury" });
      return;
    }
    const limit = Math.min(Math.max(Number(req.query["limit"] ?? 10) || 10, 1), 100);
    const tasks = feed.take(role, limit).map((it) => it.task);
    for (const t of tasks) {
      fileDispute(disputes, t);
      // The store answers the ticket from its records (ADR-012) before support sees it, so
      // control already holds the decision when the refund arrives (ADR-021).
      if (t.kind === "dispute") {
        await answerDispute(
          { world, controller, decisions, record },
          {
            disputeId: t.disputeId,
            orderIds: t.orderIds,
            claim: t.claim,
            ticketRef: t.sourceRef,
          },
          clock(),
        ).catch(() => undefined);
      }
    }
    res.json({ tasks });
  });

  // The agent's answer. Same entry point real agents use: control's submit path.
  app.post("/proposals", async (req, res) => {
    const result = await controller.submit(req.body);
    res.status(result.blockedBy === "malformed" ? 400 : 200).json(result);
  });

  // Queue a spend review for treasury (#26): each USDZ warrant's limits and spend from the ledger,
  // the Kit 11 total and, when it is over sourcing's limit, the upstream price. Moves no money.
  let reviews = 0;
  app.post("/treasury/review", owner, (_req, res) => {
    const item = spendReview({
      n: ++reviews,
      at: clock(),
      warrants: world.warrants.values(),
      spentCents: (id) => controller.ledger.spentCents(id),
      upstreamCents: world.upstream.price(),
    });
    const queued = feed.load([item]);
    // The feed gives every load after the first fresh ids (`_2`...): answer the id it queued.
    res.json({ taskId: feed.pending().at(-1)?.task.taskId, queued });
  });

  // Treasury proposes new limits for an agent (BudgetChangeProposal). Always waits for the owner.
  app.post("/budget-changes", (req, res) => {
    const r = controller.proposeBudgetChange(req.body);
    res.status(r.ok ? 200 : 400).json(r);
  });

  // Owner side (dashboard or a script standing in for the owner).
  app.get("/approvals", (_req, res) => {
    res.json({ pending: controller.approvals.list() });
  });

  app.post("/approvals/:proposalId", owner, async (req, res) => {
    const proposalId = String(req.params["proposalId"] ?? "");
    const body = req.body as { decision?: string; shownHash?: unknown } | undefined;
    const decision = body?.decision;
    const pending = controller.approvals.get(proposalId);
    if (!pending) {
      res.status(404).json({ error: "nothing pending for this proposal" });
      return;
    }
    if (decision !== "approved" && decision !== "denied") {
      res.status(400).json({ error: "decision must be approved or denied" });
      return;
    }
    // ADR-007: the answer is bound to exactly what the owner was shown. The client sends back the
    // shownHash it displayed (from GET /approvals); control refuses a stale or different view.
    if (typeof body?.shownHash !== "string" || body.shownHash === "") {
      res.status(400).json({ error: "send the shownHash of the approval you were shown" });
      return;
    }
    const result = await controller.decideApproval({
      approvalId: `apr_${proposalId}`,
      proposalId,
      shownHash: body.shownHash,
      decision,
      ownerId: OWNER_ID,
      decidedAt: clock().toISOString(),
    });
    res.json(result);
  });

  // Everything that happened, in order. Poll with ?since=<last seq>.
  app.get("/events", (req, res) => {
    const since = Number(req.query["since"] ?? 0) || 0;
    res.json({ events: log.filter((e) => e.seq > since) });
  });

  // The replay log (#22): one proposal's life, in order, from the event log and the ledger.
  app.get("/replay", (req, res) => {
    const proposalId = String(req.query["proposalId"] ?? "");
    if (proposalId === "" || proposalId.length > 128) {
      res.status(400).json({ error: "proposalId is required" });
      return;
    }
    const r = replay(proposalId, log, controller.ledger.all());
    if (!r.found) {
      res.status(404).json({ error: "nothing recorded for this proposal" });
      return;
    }
    res.json(r);
  });

  // The owner's emergency stop. Everything stops at once; the timing is part of the answer.
  app.post("/kill", owner, async (req, res) => {
    const reason = String(
      (req.body as { reason?: unknown } | undefined)?.reason ?? "owner pressed stop",
    );
    const result = await controller.engageKillSwitch(
      { ownerId: OWNER_ID, reason, warrantIds: [...world.warrants.keys()] },
      killHooks(world),
    );
    for (const [id, w] of world.warrants) world.warrants.set(id, { ...w, status: "revoked" });
    res.json(result);
  });

  app.get("/kill", (_req, res) => {
    res.json({ engaged: controller.killSwitch.engaged, last: controller.killSwitch.last ?? null });
  });

  // The mock Metal chain: each mandate's spend and limits, and every on-chain refusal. In sandbox
  // mode the chain is the testnet explorer; this answers the price and our settled payments.
  app.get("/chain", (_req, res) => {
    const { chain } = world;
    if (!chain) {
      res.json({ upstreamPriceCents: world.upstream.price(), settled: world.settled() });
      return;
    }
    res.json({
      upstreamPriceCents: world.upstream.price(),
      mandates: chain.mandateList().map((m) => ({
        credential: m.credential,
        capCents: m.capCents,
        budgetCents: m.budgetCents,
        spentCents: m.spentCents,
        revoked: m.revoked,
      })),
      refusals: chain.refusals,
      payments: chain.txs.length,
    });
  });

  // Scene control: the upstream provider changes its price (Kit 11: 2 cents, then 4).
  app.post("/upstream/price", owner, (req, res) => {
    const cents = Number((req.body as { cents?: unknown } | undefined)?.cents);
    try {
      world.upstream.setPrice(cents);
      res.json({ upstreamPriceCents: world.upstream.price() });
    } catch (e) {
      res.status(400).json({ error: (e as Error).message });
    }
  });

  // Benchmark "limits only" mode: the sourcing agent pays upstream straight through its mandate,
  // around control. Only the chain's mandate can refuse it.
  app.post("/limits-only/pay", owner, async (_req, res) => {
    const cred = world.credentials.get("sourcing") ?? "sourcing.json";
    const r = await world.payAround(cred);
    res.json({ outcome: classifyPay(r) });
  });

  // The store's stored sales, for support and the dashboard. Passes and signed offers included:
  // they are the evidence a dispute is decided on.
  app.get("/orders", (_req, res) => {
    res.json({ orders: [...world.orders().values()] });
  });

  // A customer disputes orders. The store answers from its records alone (ADR-012): one decision
  // per order, with the evidence behind it. Refunds then go through POST /proposals as usual.
  let disputesOpened = 0;
  app.post("/disputes", async (req, res) => {
    const body = DisputeRequest.safeParse(req.body);
    if (!body.success) {
      res.status(400).json({ error: "send { orderIds: string[], claim, customer? }" });
      return;
    }
    const file = await answerDispute(
      { world, controller, disputes, decisions, record },
      { disputeId: `dsp_${++disputesOpened}`, ...body.data },
      clock(),
    );
    res.json(file);
  });

  // For the analyzer only: what each task was (benign or which attack) and what should happen.
  app.get("/labels", (_req, res) => {
    res.json({ labels: feed.labels() });
  });

  return { app, controller, world, disputes, decisions, record };
}

/** A dispute task handed to support is a dispute on file: its ticket is the task's sourceRef. */
export function fileDispute(disputes: Map<string, DisputeCase>, t: AgentTask): void {
  if (t.kind !== "dispute") return;
  disputes.set(t.sourceRef, {
    disputeId: t.disputeId,
    customer: CUSTOMER_ADDRESS,
    orderIds: t.orderIds,
    claim: t.claim,
    ticketRef: t.sourceRef,
    openedAt: t.at,
  });
}

/** A state-changing request that came from another site. */
export function crossSite(req: Request): boolean {
  // Browsers that send Sec-Fetch-Site are trusted on it: a same-origin form post can still carry
  // "Origin: null" (Chrome does under a strict referrer policy), so the origin decides only when
  // that header is absent.
  const site = req.get("sec-fetch-site");
  if (site) return site !== "same-origin" && site !== "none";
  const origin = req.get("origin");
  if (!origin) return false;
  try {
    return new URL(origin).host !== req.get("host");
  } catch {
    return true;
  }
}

/** Only the owner's key passes. Compared as hashes, in constant time. */
function ownerOnly(token: string | undefined) {
  const want = token ? createHash("sha256").update(token).digest() : undefined;
  return (req: Request, res: Response, next: NextFunction): void => {
    if (!want) return next();
    const got = /^Bearer (.+)$/.exec(req.get("authorization") ?? "")?.[1] ?? "";
    if (timingSafeEqual(createHash("sha256").update(got).digest(), want)) return next();
    res.status(401).json({ error: "owner sign-in needed: open the owner link the engine printed" });
  };
}

/** What a customer sends: the orders and the claim. The store fills in the rest. */
const DisputeRequest = DisputeCase.pick({ orderIds: true, claim: true, customer: true })
  .partial({ customer: true })
  .strict();

function roleOf(req: Request): AgentRole | undefined | null {
  const raw = req.query["role"];
  if (raw === undefined) return undefined;
  const parsed = AgentRole.safeParse(raw);
  return parsed.success ? parsed.data : null;
}

export { answerDispute };
