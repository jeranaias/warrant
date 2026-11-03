import type { AgentRole, Money, PaymentProposal } from "@warrant/contracts";
import type { Replay } from "./replay.js";

/**
 * The engine's HTTP API (apps/engine/src/server.ts), typed here by hand. The dashboard only talks
 * to the engine over HTTP: it never imports engine, control, rails or agent code.
 *
 * Every path goes through `/api`, which the Vite dev server forwards to the engine
 * (see vite.config.ts). A build can point elsewhere with VITE_API_BASE.
 */
const BASE = (import.meta.env["VITE_API_BASE"] as string | undefined) || "/api";

/**
 * Built for the hosted demo (`vite build --mode hosted`, issue #89): one mock engine per visitor,
 * served by apps/engine/src/hosted.ts on the same origin.
 */
export const HOSTED = import.meta.env.MODE === "hosted";

/** Hosted demo: this visitor's engine is gone (redeploy, idle) or the sign-in lapsed (HTTP 401). */
export class SessionEnded extends Error {}

/**
 * The owner's key from the owner link (`#/m?owner=<key>` or `#/?owner=<key>`). It is moved out of
 * the address bar into this tab's session storage, and sent only on the owner's actions.
 */
const OWNER_KEY = "warrant.owner";
function ownerToken(): string | undefined {
  if (typeof location === "undefined") return undefined;
  const m = /[?&]owner=([A-Za-z0-9_-]+)/.exec(location.hash);
  try {
    if (m?.[1]) {
      sessionStorage.setItem(OWNER_KEY, m[1]);
      history.replaceState(null, "", location.hash.replace(/[?&]owner=[A-Za-z0-9_-]+/, ""));
    }
    return sessionStorage.getItem(OWNER_KEY) ?? undefined;
  } catch {
    return m?.[1];
  }
}
let owner = ownerToken();
/** True when this tab holds the owner's key (the page can approve and stop). */
export const isOwner = () => (owner ??= ownerToken()) !== undefined;

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
  decision?: {
    outcome: "execute" | "needs_owner_approval" | "blocked";
    /** Every rule control checked; the failed ones say why in `detail`. */
    rules?: { checks: { rule: string; pass: boolean; detail: string }[] };
    /** The purpose check's verdict, null when the rules already blocked. */
    purpose?: { verdict: string; explanation: string } | null;
  };
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
  event: { reason: string; at: string; revokedWarrantIds: string[]; frozenCardIds?: string[] };
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
    }
  | PassCheckedEvent
  | DisputeDecidedEvent;

/** Our store checked a buyer's warrant pass before serving (control's PassCheckedEvent). */
export interface PassCheckedEvent {
  type: "pass_checked";
  ok: boolean;
  problems: string[];
  url: string;
  amountCents: number;
  buyer?: {
    payer: string;
    ownerId: string;
    /** Fingerprint of the owner key that signed the buyer's grant. */
    ownerKey: string;
    warrantId: string;
    mandateId?: string;
    perPaymentCap: Money;
  };
}

/** The store decided a dispute from its records (control's DisputeDecidedEvent). */
export interface DisputeDecidedEvent {
  type: "dispute_decided";
  disputeId: string;
  claim: string;
  customer: string;
  refund: Money;
  orders: {
    orderId: string;
    reason: string;
    refundCents: number;
    verified: boolean;
    txHash?: string;
    mandateId?: string;
  }[];
}

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

async function call<T>(
  method: "GET" | "POST",
  path: string,
  body?: unknown,
  asOwner = false,
): Promise<T> {
  const headers: Record<string, string> =
    body === undefined ? {} : { "content-type": "application/json" };
  if (asOwner && isOwner() && owner) headers["authorization"] = `Bearer ${owner}`;
  const res = await fetch(BASE + path, {
    method,
    headers,
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const data = (await res.json().catch(() => ({}))) as T & { error?: string };
  if (!res.ok) {
    const message = data.error ?? `engine answered HTTP ${res.status}`;
    throw HOSTED && res.status === 401 ? new SessionEnded(message) : new Error(message);
  }
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
      true,
    ),
  kill: (reason: string) => call<KillResult>("POST", "/kill", { reason }, true),
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
  replay: (proposalId: string) =>
    call<Replay>("GET", `/replay?proposalId=${encodeURIComponent(proposalId)}`),
  /** Hosted demo only: a fresh engine for this visitor. */
  reset: () => call<{ ok: boolean }>("POST", "/reset"),
};
