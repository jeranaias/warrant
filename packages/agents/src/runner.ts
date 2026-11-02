import type { AgentRole, AgentTask, PaymentProposal } from "@warrant/contracts";
import type { Brain } from "./brain.js";
import { contextFor } from "./context.js";
import type { AgentContext, WorldView } from "./context.js";
import { toProposal } from "./tool.js";
import type { IdSource } from "./tool.js";

/** What happened to one proposal, in the runner's words. */
export interface ProposalOutcome {
  /** paid = control executed it; owner = waiting for the owner; blocked = refused anywhere. */
  status: "paid" | "owner" | "blocked" | "malformed";
  /** Which layer stopped it (rules, purpose, owner, rail, malformed), when blocked. */
  blockedBy?: string;
  detail?: string;
}

/** Where proposals go: the engine's POST /proposals, or a benchmark mode. */
export type Submit = (proposal: PaymentProposal) => Promise<ProposalOutcome>;

export interface ProposalRecord {
  proposal?: PaymentProposal;
  outcome: ProposalOutcome;
}

export interface TaskRun {
  taskId: string;
  role: AgentRole;
  brain: string;
  proposals: ProposalRecord[];
  error?: string;
}

export interface RunTaskOptions {
  brain: Brain;
  task: AgentTask;
  ctx: AgentContext;
  submit: Submit;
  ids: IdSource;
  clock?: () => Date;
  /** Runner-side guard on model loops; not a money control (control enforces those). */
  maxProposals?: number;
}

/** One task through one agent: the brain proposes, the runner fills ids and submits. */
export async function runTask(o: RunTaskOptions): Promise<TaskRun> {
  const clock = o.clock ?? (() => new Date());
  const max = o.maxProposals ?? 20;
  const run: TaskRun = {
    taskId: o.task.taskId,
    role: o.ctx.role,
    brain: o.brain.name,
    proposals: [],
  };
  try {
    await o.brain.act(o.task, o.ctx, async (input) => {
      if (run.proposals.length >= max) return "not submitted: proposal limit for this task reached";
      const built = toProposal(input, o.task, o.ctx, o.ids, clock());
      if (!built.ok) {
        run.proposals.push({ outcome: { status: "malformed", detail: built.error } });
        return `not submitted: ${built.error}`;
      }
      const outcome = await o.submit(built.proposal);
      run.proposals.push({ proposal: built.proposal, outcome });
      return describe(outcome);
    });
  } catch (e) {
    run.error = String(e).slice(0, 300);
  }
  return run;
}

function describe(o: ProposalOutcome): string {
  if (o.status === "paid") return "control: execute (paid)";
  if (o.status === "owner") return "control: needs_owner_approval (waiting for the owner; final)";
  return `control: blocked${o.blockedBy ? ` by ${o.blockedBy}` : ""} (final, do not retry)`;
}

/** The engine's HTTP API, as the agents use it (apps/engine/CLAUDE.md). */
export class EngineClient {
  constructor(private readonly base: string) {}

  world(): Promise<WorldView> {
    return this.get<WorldView>("/world");
  }

  async tasks(role: AgentRole, limit = 10): Promise<AgentTask[]> {
    return (await this.get<{ tasks: AgentTask[] }>(`/tasks?role=${role}&limit=${limit}`)).tasks;
  }

  /** POST /proposals. Control's answer, mapped to a runner outcome. */
  readonly submit: Submit = async (proposal) => {
    const res = await fetch(`${this.base}/proposals`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(proposal),
    });
    const body = (await res.json()) as EngineSubmitResult;
    return outcomeOf(body);
  };

  /** The scenario names the engine can load (GET /scenarios). */
  async scenarios(): Promise<string[]> {
    return (await this.get<{ scenarios: string[] }>("/scenarios")).scenarios;
  }

  /**
   * POST /scenario: replace the engine's task queue with a scenario's tasks. Returns how many
   * were queued. Driver-side only: brains never call this.
   */
  async loadScenario(name: string): Promise<number> {
    const res = await fetch(`${this.base}/scenario`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name }),
    });
    const body = (await res.json()) as { queued?: number; error?: string };
    if (!res.ok || body.queued === undefined) {
      throw new Error(`engine /scenario ${name}: ${body.error ?? `HTTP ${res.status}`}`);
    }
    return body.queued;
  }

  private async get<T>(path: string): Promise<T> {
    const res = await fetch(this.base + path);
    if (!res.ok) throw new Error(`engine ${path}: HTTP ${res.status}`);
    return (await res.json()) as T;
  }
}

/** The fields of the engine's SubmitResult the runner reads. */
export interface EngineSubmitResult {
  decision?: { outcome: "execute" | "needs_owner_approval" | "blocked" };
  execution?: { status: string; detail?: string };
  blockedBy?: string;
  error?: string;
}

export function outcomeOf(r: EngineSubmitResult): ProposalOutcome {
  const detail = r.error ?? r.execution?.detail;
  const extra = detail ? { detail } : {};
  if (r.blockedBy === "malformed") return { status: "malformed", blockedBy: "malformed", ...extra };
  if (r.decision?.outcome === "needs_owner_approval") return { status: "owner", ...extra };
  if (r.decision?.outcome === "execute" && r.execution?.status === "succeeded") {
    return { status: "paid", ...extra };
  }
  // A pending / unknown rail answer is not money we can count as moved or as stopped; the bench
  // treats it as blocked by the rail and shows the detail.
  return { status: "blocked", blockedBy: r.blockedBy ?? "rail", ...extra };
}

export interface LoopOptions {
  engine: EngineClient;
  brain: Brain;
  ids: IdSource;
  roles?: AgentRole[];
  /** Tasks to take per role per round. */
  batch?: number;
  onRun?: (run: TaskRun) => void;
}

/**
 * The live loop: for each role, take tasks from the engine until its queue is empty, let the
 * agent act on each, submit what it proposes. Returns every run, in order.
 */
export async function runLoop(o: LoopOptions): Promise<TaskRun[]> {
  const world = await o.engine.world();
  const runs: TaskRun[] = [];
  for (const role of o.roles ?? (["sourcing", "support", "treasury"] as const)) {
    const ctx = contextFor(world, role);
    for (;;) {
      const tasks = await o.engine.tasks(role, o.batch ?? 10);
      if (tasks.length === 0) break;
      for (const task of tasks) {
        const run = await runTask({
          brain: o.brain,
          task,
          ctx,
          submit: o.engine.submit,
          ids: o.ids,
        });
        runs.push(run);
        o.onRun?.(run);
      }
    }
  }
  return runs;
}
