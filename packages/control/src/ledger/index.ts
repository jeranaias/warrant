import { appendFileSync, existsSync, readFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { LedgerEntry } from "@warrant/contracts";
import type { LedgerEntryType, Money, Rail } from "@warrant/contracts";
import { canonicalize, sha256Hex } from "../crypto.js";

export const GENESIS_HASH = "0".repeat(64);

export interface ReserveInput {
  proposalId: string;
  warrantId: string;
  rail: Rail;
  amount: Money;
  idempotencyKey: string;
  payeeId?: string;
}

/** State of one reservation, derived from the log. */
export interface Reservation extends ReserveInput {
  reservationId: string;
  state: "reserved" | "unconfirmed" | "confirmed" | "released";
  railRef?: string;
  reservedAt: string;
}

type Draft = Omit<LedgerEntry, "seq" | "entryId" | "prevHash" | "hash" | "at">;

/**
 * Append-only, hash-chained ledger (ADR-002, CLAUDE.md money rules).
 *
 *   reserve -> rail call -> confirm | release
 *   reserve -> timeout   -> unconfirmed -> (status check) -> confirm | release
 *
 * Node runs this synchronously, so check-then-reserve inside one call is atomic: the same cents
 * can't be reserved twice. Optional JSONL file persistence; the file is re-verified on load.
 */
export class Ledger {
  private readonly entries: LedgerEntry[] = [];
  private readonly reservations = new Map<string, Reservation>();
  private readonly keys = new Set<string>();

  constructor(
    private readonly file?: string,
    private readonly clock: () => Date = () => new Date(),
  ) {
    if (file && existsSync(file)) {
      for (const line of readFileSync(file, "utf8").split("\n")) {
        if (line.trim()) this.apply(LedgerEntry.parse(JSON.parse(line)));
      }
      const bad = verifyChain(this.entries);
      if (bad !== null) throw new Error(`ledger file tampered at seq ${bad}`);
    }
  }

  /** Reserve funds before any rail call. Throws on a reused idempotency key. */
  reserve(input: ReserveInput): Reservation {
    if (this.keys.has(input.idempotencyKey)) {
      throw new Error("idempotency key already reserved");
    }
    const reservationId = `res_${randomUUID()}`;
    this.append({
      type: "reserve",
      reservationId,
      proposalId: input.proposalId,
      warrantId: input.warrantId,
      rail: input.rail,
      amount: input.amount,
      idempotencyKey: input.idempotencyKey,
      ...(input.payeeId ? { payeeId: input.payeeId } : {}),
    });
    return this.get(reservationId);
  }

  /** The rail call succeeded. Allowed from reserved or unconfirmed. */
  confirm(reservationId: string, railRef?: string): Reservation {
    const r = this.open(reservationId);
    this.append({ ...this.link(r), type: "confirm", ...(railRef ? { railRef } : {}) });
    return this.get(reservationId);
  }

  /** The rail call failed and moved nothing. Allowed from reserved or unconfirmed. */
  release(reservationId: string, railRef?: string): Reservation {
    const r = this.open(reservationId);
    this.append({ ...this.link(r), type: "release", ...(railRef ? { railRef } : {}) });
    return this.get(reservationId);
  }

  /** Timeout or ambiguous answer: keep the money held until a status check resolves it. */
  markUnconfirmed(reservationId: string, railRef?: string): Reservation {
    const r = this.get(reservationId);
    if (r.state !== "reserved") throw new Error(`cannot mark ${r.state} reservation unconfirmed`);
    this.append({ ...this.link(r), type: "unconfirmed", ...(railRef ? { railRef } : {}) });
    return this.get(reservationId);
  }

  /** Money received (a sale, or earnings arriving in Airwallex). */
  inbound(amount: Money, railRef: string, rail?: Rail): LedgerEntry {
    return this.append({ type: "inbound", amount, railRef, ...(rail ? { rail } : {}) });
  }

  /** Kill switch: release every open reservation, then record the event. */
  killSwitch(): { releasedReservationIds: string[]; entry: LedgerEntry } {
    const released: string[] = [];
    for (const r of this.reservations.values()) {
      // unconfirmed money may have moved: it stays held until a status check
      if (r.state === "reserved") {
        this.release(r.reservationId);
        released.push(r.reservationId);
      }
    }
    const entry = this.append({ type: "kill_switch", amount: { currency: "USD", cents: 0 } });
    return { releasedReservationIds: released, entry };
  }

  get(reservationId: string): Reservation {
    const r = this.reservations.get(reservationId);
    if (!r) throw new Error(`unknown reservation ${reservationId}`);
    return { ...r };
  }

  /** Confirmed + open (reserved or unconfirmed) cents under a warrant. */
  committedCents(warrantId: string): number {
    let total = 0;
    for (const r of this.reservations.values()) {
      if (r.warrantId === warrantId && r.state !== "released") total += r.amount.cents;
    }
    return total;
  }

  spentCents(warrantId: string): number {
    let total = 0;
    for (const r of this.reservations.values()) {
      if (r.warrantId === warrantId && r.state === "confirmed") total += r.amount.cents;
    }
    return total;
  }

  hasKey(idempotencyKey: string): boolean {
    return this.keys.has(idempotencyKey);
  }

  idempotencyKeys(): ReadonlySet<string> {
    return this.keys;
  }

  /** Not released, under a warrant. For the duplicate guard. */
  activeReservations(warrantId: string): Reservation[] {
    return [...this.reservations.values()]
      .filter((r) => r.warrantId === warrantId && r.state !== "released")
      .map((r) => ({ ...r }));
  }

  /** Reservations waiting for a status check. */
  unconfirmed(): Reservation[] {
    return [...this.reservations.values()]
      .filter((r) => r.state === "unconfirmed")
      .map((r) => ({ ...r }));
  }

  all(): readonly LedgerEntry[] {
    return this.entries;
  }

  private open(reservationId: string): Reservation {
    const r = this.get(reservationId);
    if (r.state !== "reserved" && r.state !== "unconfirmed") {
      throw new Error(`reservation already ${r.state}`);
    }
    return r;
  }

  private link(r: Reservation) {
    return {
      reservationId: r.reservationId,
      proposalId: r.proposalId,
      warrantId: r.warrantId,
      rail: r.rail,
      amount: r.amount,
      idempotencyKey: r.idempotencyKey,
    };
  }

  private append(draft: Draft): LedgerEntry {
    const prev = this.entries.at(-1);
    const body = {
      ...draft,
      seq: this.entries.length,
      entryId: `led_${randomUUID()}`,
      prevHash: prev ? prev.hash : GENESIS_HASH,
      at: this.clock().toISOString(),
    };
    const entry = LedgerEntry.parse({ ...body, hash: entryHash(body) });
    this.apply(entry);
    if (this.file) appendFileSync(this.file, JSON.stringify(entry) + "\n");
    return entry;
  }

  private apply(e: LedgerEntry): void {
    this.entries.push(e);
    if (!e.reservationId) return;
    const type: LedgerEntryType = e.type;
    if (type === "reserve") {
      if (!e.proposalId || !e.warrantId || !e.rail || !e.idempotencyKey) {
        throw new Error("reserve entry missing fields");
      }
      this.keys.add(e.idempotencyKey);
      const payeeId = e.payeeId;
      this.reservations.set(e.reservationId, {
        reservationId: e.reservationId,
        proposalId: e.proposalId,
        warrantId: e.warrantId,
        rail: e.rail,
        amount: e.amount,
        idempotencyKey: e.idempotencyKey,
        ...(payeeId ? { payeeId } : {}),
        state: "reserved",
        reservedAt: e.at,
      });
      return;
    }
    const r = this.reservations.get(e.reservationId);
    if (!r) throw new Error(`entry ${e.seq} resolves unknown reservation`);
    if (type === "confirm") r.state = "confirmed";
    else if (type === "release") r.state = "released";
    else if (type === "unconfirmed") r.state = "unconfirmed";
    if (e.railRef) r.railRef = e.railRef;
  }
}

/** sha256(prevHash + canonical(entry without hash)). */
export function entryHash(entry: Omit<LedgerEntry, "hash">): string {
  return sha256Hex(entry.prevHash + canonicalize(entry));
}

/** Returns the seq of the first broken entry, or null if the whole chain is intact. */
export function verifyChain(entries: readonly LedgerEntry[]): number | null {
  let prev = GENESIS_HASH;
  for (const [i, e] of entries.entries()) {
    const { hash, ...rest } = e;
    if (e.seq !== i || e.prevHash !== prev || entryHash(rest) !== hash) return i;
    prev = hash;
  }
  return null;
}
