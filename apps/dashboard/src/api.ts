import type { AgentRole, Money, PaymentProposal } from "@warrant/contracts";

/**
 * The engine's HTTP API (apps/engine/src/server.ts), typed here by hand. The dashboard only talks
 * to the engine over HTTP: it never imports engine, control, rails or agent code.
 *
 * Every path goes through `/api`, which the Vite dev server forwards to the engine
 * (see vite.config.ts). Change BASE if the engine is ever served from somewhere else.
 */
const BASE = "/api";

export type { AgentRole, Money };

export interface PayeeRow {
  payeeId: string;
  displayName: string;
  rail: string;
  currency: string;
}

/** One agent's signed warrant, plus what it has spent so far (GET /world). */
export interface WarrantRow {
  warrantId: string;
  version: number;
  agentId: string;
  agentRole: AgentRole;
  purpose: string;
  allowedRails: string[];
  payees: PayeeRow[];
  perPaymentCap: Money;
  totalBudget: Money;
  spentCents: number;
}

export interface OrderRow {
  orderId: string;
  resource: string;
  price: Money;
  at: string;
}

export interface World {
  ownerId: string;
  agents: Record<string, { role: AgentRole; agentId: string; warrantId: string }>;
  warrants: WarrantRow[];
  orders: OrderRow[];
}

/** Something waiting for the owner. `view` is exactly what control will hold the owner to. */
export interface PendingApproval {
  proposalId: string;
  view: Record<string, unknown>;
  shownHash: string;
  reasons: string[];
  requestedAt: string;
}

export interface SubmitResult {
  decision?: { outcome: "execute" | "needs_owner_approval" | "blocked" };
  blockedBy?: "malformed" | "rules" | "purpose" | "owner" | "rail";
  error?: string;
}

export interface Execution {
  reservationId: string;
  status: "succeeded" | "failed" | "pending" | "unknown";
  railRef?: string;
  detail?: string;
}

export interface KillResult {
  event: { reason: string; at: string; revokedWarrantIds: string[] };
  revokedMandates: string[];
  problems: string[];
  durationMs: number;
}

/** The events control writes, in order (GET /events). Mirrors ControlEvent in control. */
export type ControlEvent =
  | { type: "proposal"; proposal: PaymentProposal; result: SubmitResult }
  | { type: "approval_requested"; pending: PendingApproval }
  | { type: "approval_decided"; proposalId: string; ok: boolean; decision?: "approved" | "denied" }
  | { type: "execution"; proposalId: string; execution: Execution }
  | { type: "kill_switch"; result: KillResult }
  | {
      type: "budget_changed";
      proposalId: string;
      warrantId: string;
      fromVersion: number;
      toVersion: number;
    };

export interface LoggedEvent {
  seq: number;
  at: string;
  event: ControlEvent;
}

export interface KillState {
  engaged: boolean;
  last: KillResult | null;
}

/** The mock Metal chain (GET /chain). Amounts are USDZ cents. */
export interface ChainView {
  upstreamPriceCents: number;
  mandates: {
    credential: string;
    capCents: number;
    budgetCents: number;
    spentCents: number | null;
    revoked: boolean;
  }[];
  refusals: { mandateId: string; reason: string; to: string; cents: number; at: string }[];
  payments: number;
}

async function call<T>(method: "GET" | "POST", path: string, body?: unknown): Promise<T> {
  const res = await fetch(BASE + path, {
    method,
    headers: body === undefined ? {} : { "content-type": "application/json" },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const data = (await res.json().catch(() => ({}))) as T & { error?: string };
  if (!res.ok) throw new Error(data.error ?? `engine answered HTTP ${res.status}`);
  return data;
}

export const api = {
  world: () => call<World>("GET", "/world"),
  events: (since: number) => call<{ events: LoggedEvent[] }>("GET", `/events?since=${since}`),
  approvals: () => call<{ pending: PendingApproval[] }>("GET", "/approvals"),
  /**
   * Answer one approval. We send back the hash of the view we showed; the engine binds the
   * decision to the view it stored, and control voids an approval if that view has changed.
   */
  decide: (a: PendingApproval, decision: "approved" | "denied") =>
    call<{ ok: boolean; error?: string }>(
      "POST",
      `/approvals/${encodeURIComponent(a.proposalId)}`,
      { decision, shownHash: a.shownHash },
    ),
  kill: (reason: string) => call<KillResult>("POST", "/kill", { reason }),
  killState: () => call<KillState>("GET", "/kill"),
  chain: () => call<ChainView>("GET", "/chain"),
  scenarios: () => call<{ scenarios: string[] }>("GET", "/scenarios"),
  loadScenario: (name: string) => call<{ queued: number }>("POST", "/scenario", { name }),
  setUpstreamPrice: (cents: number) =>
    call<{ upstreamPriceCents: number }>("POST", "/upstream/price", { cents }),
  proposeBudgetChange: (body: {
    proposalId: string;
    warrantId: string;
    agentId: string;
    newTotalBudget: Money;
    newPerPaymentCap?: Money;
    justification: string;
    createdAt: string;
  }) => call<{ ok: boolean; error?: string }>("POST", "/budget-changes", body),
};
