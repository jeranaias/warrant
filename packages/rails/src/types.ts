import type { Money, Rail } from "@warrant/contracts";

/**
 * ONE interface for every rail. Control is the only caller.
 * Implementations exist per environment (mock, sandbox) so sandbox-only simulation calls
 * (e.g. Airwallex simulated transfer status / card authorization) can be swapped in
 * without touching control.
 */

/** An instruction control has already approved AND reserved in the ledger. */
export interface RailInstruction {
  rail: Rail;
  reservationId: string;
  /** Pass through to the rail. A retry with the same key must never pay twice. */
  idempotencyKey: string;
  amount: Money;
  /** From the warrant's payee list, never from agent input. */
  routingRef: string;
  targetCurrency?: Money["currency"];
}

export type RailStatus = "succeeded" | "failed" | "pending" | "unknown";

export interface RailResult {
  status: RailStatus;
  /** Rail-side id (tx hash, Airwallex transfer / conversion / authorization id). */
  railRef?: string;
  /** Short, sanitized. Never contains keys, card data or raw upstream text. */
  detail?: string;
}

export interface RailAdapter {
  readonly rail: Rail;
  /**
   * Execute an approved instruction. A timeout MUST resolve to status "unknown",
   * never "failed": control then calls getStatus() before anything else.
   */
  execute(instruction: RailInstruction): Promise<RailResult>;
  /** Look up the outcome of a prior execute() by its idempotency key. */
  getStatus(idempotencyKey: string): Promise<RailResult>;
}

/** Card-only controls, used by the kill switch. */
export interface CardControls {
  freezeAll(): Promise<{ frozenCardIds: string[] }>;
}

export type RailsMode = "mock" | "sandbox";
