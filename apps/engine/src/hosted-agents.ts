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
import { deterministicPurpose } from "@warrant/control";
import { createEngine } from "./server.js";
import type { Engine } from "./server.js";

/**
 * Hosted demo: the three agents, running inside each visitor's session (#89). Locally the agents
 * are their own process (`pnpm agents`); on the host nothing else runs, so without this a loaded
 * scenario would sit in the queue. Scripted brain only: no model, no keys.
 *
 * The agents talk to their engine the way they always do, over its HTTP API, on a private
 * loopback port. One task at a time, round robin across the roles, `paceMs` apart, so a person can
 * watch each payment reach the gate. STOP needs nothing here: control refuses everything after it.
 */

/**
 * One visitor's engine: the deterministic purpose check, and an empty queue. The agents wait
 * until the visitor loads a scenario, so nothing is paid before they have done anything.
 */
export function hostedEngine(ownerToken: string): Engine {
  return createEngine({ purpose: deterministicPurpose, ownerToken, scenario: "none" });
}

export interface AgentDriver {
  stop: () => void;
}

export interface DriverOptions {
  /** Pause after a task, so the dashboard shows one payment at a time. */
  paceMs?: number;
  /** How often an empty queue is checked again. */
  idleMs?: number;
}

const ROLES: readonly AgentRole[] = ["sourcing", "support", "treasury"];

export function startAgents(engine: Engine, opts: DriverOptions = {}): AgentDriver {
  const paceMs = opts.paceMs ?? 1_800;
  const idleMs = opts.idleMs ?? 1_000;
  const brain = new ScriptedBrain();
  const ids = counterIds(Date.now().toString(36));
  const server: Server = engine.app.listen(0, "127.0.0.1");
  let client: EngineClient | undefined;
  let next = 0;
  let stopped = false;
  let timer: NodeJS.Timeout | undefined;

  /** One task from the next role that has one. False when every queue is empty. */
  const step = async (c: EngineClient): Promise<boolean> => {
    for (let i = 0; i < ROLES.length; i++) {
      const role = ROLES[(next + i) % ROLES.length] ?? "sourcing";
      const [task] = await c.tasks(role, 1);
      if (!task) continue;
      next = (next + i + 1) % ROLES.length;
      const ctx = contextFor(await c.world(), role);
      await runTask({ brain, task, ctx, submit: c.submit, ids });
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
