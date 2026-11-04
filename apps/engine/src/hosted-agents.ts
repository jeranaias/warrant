import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import type { AgentRole } from "@warrant/contracts";
import {
  EngineClient,
  ScriptedBrain,
  contextFor,
  counterIds,
  runTask,
} from "@warrant/agents/offline";
import { ModelBrain } from "@warrant/agents";
import type { Brain } from "@warrant/agents";
import { deterministicPurpose, modelPurpose } from "@warrant/control";
import type { SessionModel } from "./hosted-model.js";
import { createEngine } from "./server.js";
import type { Engine } from "./server.js";

/**
 * The three agents, running inside an engine: each hosted visitor's session (#89), and `pnpm live`
 * locally. Otherwise the agents are their own process (`pnpm agents`); on the host nothing else
 * runs, so without this a loaded scenario would sit in the queue. Scripted brain unless a model is
 * given.
 *
 * The agents talk to their engine the way they always do, over its HTTP API, on a private
 * loopback port. One task at a time, round robin across the roles, `paceMs` apart, so a person can
 * watch each payment reach the gate. STOP needs nothing here: control refuses everything after it.
 *
 * With a visitor's own key (ADR-023) the agents and the purpose check run on the model instead,
 * through that session's counted clients; once its calls are used up the agents stop taking tasks.
 */

/**
 * One visitor's engine: the deterministic purpose check, and an empty queue. The agents wait
 * until the visitor loads a scenario, so nothing is paid before they have done anything.
 */
export function hostedEngine(ownerToken: string, model?: SessionModel): Engine {
  const purpose = model
    ? modelPurpose({ complete: model.complete, model: model.model })
    : deterministicPurpose;
  return createEngine({ purpose, ownerToken, scenario: "none" });
}

export interface AgentDriver {
  stop: () => void;
}

export interface DriverOptions {
  /** Pause after a task, so the dashboard shows one payment at a time. */
  paceMs?: number;
  /** How often an empty queue is checked again. */
  idleMs?: number;
  /** The visitor's own model access; the scripted brain without it. */
  model?: SessionModel;
  /**
   * Any other brain (`pnpm live`: the model on the repo's key, or the script), with the check that
   * says its calls are used up. Ignored when `model` is given.
   */
  brain?: Brain;
  exhausted?: () => boolean;
}

const ROLES: readonly AgentRole[] = ["sourcing", "support", "treasury"];

export function startAgents(engine: Engine, opts: DriverOptions = {}): AgentDriver {
  const paceMs = opts.paceMs ?? 1_800;
  const idleMs = opts.idleMs ?? 1_000;
  const model = opts.model;
  const brain: Brain = model
    ? new ModelBrain({ create: model.create, model: model.model })
    : (opts.brain ?? new ScriptedBrain());
  const exhausted = model ? () => model.exhausted() : (opts.exhausted ?? (() => false));
  const ids = counterIds(Date.now().toString(36));
  const server: Server = engine.app.listen(0, "127.0.0.1");
  let client: EngineClient | undefined;
  let next = 0;
  let stopped = false;
  let timer: NodeJS.Timeout | undefined;

  /** One task from the next role that has one. False when every queue is empty. */
  const step = async (c: EngineClient): Promise<boolean> => {
    // Calls used up: leave the queue alone rather than take tasks nobody will answer.
    if (exhausted()) return false;
    for (let i = 0; i < ROLES.length; i++) {
      const role = ROLES[(next + i) % ROLES.length] ?? "sourcing";
      const [task] = await c.tasks(role, 1);
      if (!task) continue;
      next = (next + i + 1) % ROLES.length;
      const ctx = contextFor(await c.world(), role);
      // Treasury's limit changes go to POST /budget-changes, so a spend review is answered too.
      await runTask({ brain, task, ctx, submit: c.submit, submitLimits: c.submitLimits, ids });
      return true;
    }
    return false;
  };

  const tick = async (): Promise<void> => {
    let worked = false;
    try {
      if (client) worked = await step(client);
    } catch {
      // The engine went away (session reset or ended) or answered oddly: try again next tick.
    }
    if (!stopped) timer = setTimeout(() => void tick(), worked ? paceMs : idleMs);
  };

  server.once("listening", () => {
    client = new EngineClient(`http://127.0.0.1:${(server.address() as AddressInfo).port}`);
    if (!stopped) void tick();
  });

  return {
    stop: () => {
      stopped = true;
      if (timer) clearTimeout(timer);
      server.close();
      server.closeAllConnections();
    },
  };
}
