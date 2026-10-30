import express from "express";
import type { Express, Request } from "express";
import { AgentRole } from "@warrant/contracts";
import { Controller } from "@warrant/control";
import { classifyPay } from "@warrant/rails";
import { UPSTREAM_URL } from "@warrant/mocks/metal";
import type { ControlEvent, PurposeChecker } from "@warrant/control";
import { SCENARIOS, TaskFeed, scenario } from "@warrant/mocks/feed";
import type { ScenarioName } from "@warrant/mocks/feed";
import { AGENTS, OWNER_ID, makeWorld, placeholderPurpose } from "./world.js";
import type { World } from "./world.js";

/**
 * The engine: one local server that hands agents their work and runs what they propose through
 * control. Lane A's loop:
 *
 *   GET  /tasks?role=sourcing   -> tasks for that agent (offer, ticket, invoice)
 *   ...agent decides...
 *   POST /proposals             -> PaymentProposal in, control's decision out
 *   GET  /events                -> everything that happened, for the analyzer and the dashboard
 *
 * Mock rails only: nothing here moves real money.
 */

export interface EngineOptions {
  purpose?: PurposeChecker;
  /** Load this scenario at startup. */
  scenario?: ScenarioName | "none";
  clock?: () => Date;
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
}

export function createEngine(opts: EngineOptions = {}): Engine {
  const clock = opts.clock ?? (() => new Date());
  const world = makeWorld(clock());
  const feed = new TaskFeed();
  const log: LoggedEvent[] = [];

  const controller = new Controller({
    ownerPublicKey: world.ownerPublicKey,
    getWarrant: (id) => world.warrants.get(id),
    rails: world.rails,
    purpose: opts.purpose ?? placeholderPurpose,
    orders: () => world.orders,
    credentialFor: (w) => world.credentials.get(w.agentRole),
    applyBudgetChange: world.applyBudgetChange,
    budgetCheck: world.budgetCheck,
    clock,
    onEvent: (event) => log.push({ seq: log.length + 1, at: clock().toISOString(), event }),
  });

  const initial = opts.scenario ?? "all";
  if (initial !== "none") feed.load(scenario(initial, clock()));

  const app = express();
  app.disable("x-powered-by");
  app.use(express.json({ limit: "100kb" }));

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
      orders: [...world.orders.values()].map(({ orderId, resource, price, at }) => ({
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
  app.post("/scenario", (req, res) => {
    const name = (req.body as { name?: string } | undefined)?.name;
    if (!SCENARIOS.includes(name as ScenarioName)) {
      res.status(400).json({ error: `name must be one of ${SCENARIOS.join(", ")}` });
      return;
    }
    feed.clear();
    res.json({ queued: feed.load(scenario(name as ScenarioName, clock())) });
  });

  // Next tasks. Taking a task removes it from the queue. Labels stay server-side.
  app.get("/tasks", (req, res) => {
    const role = roleOf(req);
    if (role === null) {
      res.status(400).json({ error: "role must be sourcing, support or treasury" });
      return;
    }
    const limit = Math.min(Math.max(Number(req.query["limit"] ?? 10) || 10, 1), 100);
    res.json({ tasks: feed.take(role, limit).map((it) => it.task) });
  });

  // The agent's answer. Same entry point real agents use: control's submit path.
  app.post("/proposals", async (req, res) => {
    const result = await controller.submit(req.body);
    res.status(result.blockedBy === "malformed" ? 400 : 200).json(result);
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

  app.post("/approvals/:proposalId", async (req, res) => {
    const proposalId = req.params["proposalId"] ?? "";
    const decision = (req.body as { decision?: string } | undefined)?.decision;
    const pending = controller.approvals.get(proposalId);
    if (!pending) {
      res.status(404).json({ error: "nothing pending for this proposal" });
      return;
    }
    if (decision !== "approved" && decision !== "denied") {
      res.status(400).json({ error: "decision must be approved or denied" });
      return;
    }
    const result = await controller.decideApproval({
      approvalId: `apr_${proposalId}`,
      proposalId,
      shownHash: pending.shownHash,
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

  // The owner's emergency stop. Everything stops at once; the timing is part of the answer.
  app.post("/kill", async (req, res) => {
    const reason = String(
      (req.body as { reason?: unknown } | undefined)?.reason ?? "owner pressed stop",
    );
    const result = await controller.engageKillSwitch(
      { ownerId: OWNER_ID, reason, warrantIds: [...world.warrants.keys()] },
      {
        revokeMandates: () => {
          const live = world.chain.mandateList().filter((m) => !m.revoked);
          for (const m of live) world.chain.revokeMandate(m.credential);
          return Promise.resolve(live.map((m) => m.credential));
        },
      },
    );
    for (const [id, w] of world.warrants) world.warrants.set(id, { ...w, status: "revoked" });
    res.json(result);
  });

  app.get("/kill", (_req, res) => {
    res.json({ engaged: controller.killSwitch.engaged, last: controller.killSwitch.last ?? null });
  });

  // The mock Metal chain: each mandate's spend and limits, and every on-chain refusal.
  app.get("/chain", (_req, res) => {
    res.json({
      upstreamPriceCents: world.upstream.price(),
      mandates: world.chain.mandateList().map((m) => ({
        credential: m.credential,
        capCents: m.capCents,
        budgetCents: m.budgetCents,
        spentCents: m.spentCents,
        revoked: m.revoked,
      })),
      refusals: world.chain.refusals,
      payments: world.chain.txs.length,
    });
  });

  // Scene control: the upstream provider changes its price (Kit 11: 2 cents, then 4).
  app.post("/upstream/price", (req, res) => {
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
  app.post("/limits-only/pay", async (_req, res) => {
    const run = world.chain.runner();
    const cred = world.credentials.get("sourcing") ?? "sourcing.json";
    const r = await run(["pay", UPSTREAM_URL, "--mandate", cred], 60_000);
    res.json({ outcome: classifyPay(r) });
  });

  // For the analyzer only: what each task was (benign or which attack) and what should happen.
  app.get("/labels", (_req, res) => {
    res.json({ labels: feed.labels() });
  });

  return { app, controller, world };
}

function roleOf(req: Request): AgentRole | undefined | null {
  const raw = req.query["role"];
  if (raw === undefined) return undefined;
  const parsed = AgentRole.safeParse(raw);
  return parsed.success ? parsed.data : null;
}
