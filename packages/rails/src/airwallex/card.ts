import type { Money, Payee, WarrantBody } from "@warrant/contracts";
import type { CardControls, RailAdapter, RailInstruction, RailResult } from "../types.js";
import { AirwallexTimeout, cents, major } from "./index.js";
import type { AirwallexClient } from "./index.js";

/**
 * `airwallex_card`: an Airwallex-issued virtual Visa card that the warrant governs twice. Control
 * decides first; then the card's own `authorization_controls` (set from the same signed warrant)
 * let the card network refuse anything the warrant would not allow: defence in depth.
 *
 *   issue()      use the given card, or an ACTIVE one, or create one; its controls mirror the warrant
 *   execute()    one purchase on the card. Sandbox and mock: the simulated single-phase purchase
 *   getStatus()  the purchase made under an idempotency key, looked up in the issuing transactions
 *   freezeAll()  every card this adapter issued or adopted goes INACTIVE (the kill switch)
 *
 * PAN and CVV are never fetched (no `/details` call), never returned and never logged. Every line
 * this adapter writes or returns goes through `redact()` as well, in case an upstream echoes one.
 */

/* eslint-disable @typescript-eslint/no-explicit-any */
type Json = Record<string, any>;

/** The parts of a warrant the card mirrors. */
export type CardWarrant = Pick<
  WarrantBody,
  "perPaymentCap" | "totalBudget" | "expiresAt" | "payees"
>;

export interface AirwallexCardsOptions {
  /** Every line the adapter logs (already redacted). Default: nothing is logged. */
  log?: (line: string) => void;
  /** `created_by` on a new card. */
  createdBy?: string;
  /** Email for a DELEGATE cardholder, made only when the account has none. */
  cardholderEmail?: string;
}

export interface IssueOptions {
  /** Use this card (it must be ACTIVE). Sandbox: env AIRWALLEX_CARD_ID. */
  cardId?: string;
  /** Cardholder for a new card. Default: the account's first cardholder, else a new DELEGATE one. */
  cardholderId?: string;
  /** request_id for a new card. Airwallex never replays a card create, so make it unique. */
  requestId: string;
}

export interface IssuedCard {
  cardId: string;
  /** Where the card came from. */
  source: "given" | "listed" | "created";
  /**
   * Whether the card's own controls now mirror the warrant. `mirrored` (created that way, or
   * already so), `updated` (the adapter changed them) or `not mirrored: <why>`.
   */
  controls: string;
}

/** 13 to 19 digits in a row: anything that could be a card number. */
const PAN = /\d{13,19}/g;

/** Strip anything that could be a card number. */
export function redact(text: string): string {
  return text.replace(PAN, "[redacted]");
}

const codeOf = (b: any): string =>
  typeof b?.code === "string" ? redact(String(b.code).slice(0, 60)) : "unexpected answer";

/** The card payees of a warrant, by routing ref. */
function cardPayees(w: CardWarrant): Payee[] {
  return w.payees.filter((p) => p.rail === "airwallex_card");
}

/**
 * The card's `authorization_controls` for a warrant: per-payment cap -> PER_TRANSACTION, total
 * budget -> ALL_TIME, `active_to` = the warrant's expiry, the payees' merchant categories (all of
 * them, or none if any card payee has no code, since an empty list allows every category) and the
 * currencies the warrant pays in.
 */
export function cardControls(w: CardWarrant): Json {
  const ccy = w.perPaymentCap.currency;
  if (ccy === "USDZ" || w.totalBudget.currency !== ccy) {
    throw new Error("a card warrant needs its cap and budget in one card currency");
  }
  const payees = cardPayees(w);
  const codes = payees.map((p) => p.merchantCategoryCode);
  const categories = codes.every((c): c is string => c !== undefined) ? [...new Set(codes)] : [];
  const currencies = [...new Set([ccy, ...payees.map((p) => p.currency)])].filter(
    (c) => c !== "USDZ",
  );
  return {
    active_to: w.expiresAt,
    allowed_currencies: currencies,
    allowed_merchant_categories: categories,
    allowed_transaction_count: "MULTIPLE",
    transaction_limits: {
      currency: ccy,
      limits: [
        { amount: Number(major(w.perPaymentCap.cents)), interval: "PER_TRANSACTION" },
        { amount: Number(major(w.totalBudget.cents)), interval: "ALL_TIME" },
      ],
    },
  };
}

/** What differs between a card's controls and the warrant's. Empty: they match. */
export function controlsDiffer(have: Json | undefined, want: Json): string[] {
  const out: string[] = [];
  const lim = (c: Json | undefined, interval: string) =>
    cents(
      (c?.transaction_limits?.limits as Json[] | undefined)?.find((l) => l.interval === interval)
        ?.amount,
    );
  for (const interval of ["PER_TRANSACTION", "ALL_TIME"]) {
    if (lim(have, interval) !== lim(want, interval)) out.push(`${interval} limit`);
  }
  if (have?.transaction_limits?.currency !== want.transaction_limits.currency) {
    out.push("limit currency");
  }
  const same = (a: unknown, b: string[]) =>
    Array.isArray(a) && a.length === b.length && b.every((x) => a.includes(x));
  if (!same(have?.allowed_merchant_categories, want.allowed_merchant_categories)) {
    out.push("merchant categories");
  }
  if (!same(have?.allowed_currencies, want.allowed_currencies)) out.push("currencies");
  return out;
}

/**
 * A simulated purchase's answer -> control's view. The legacy sandbox shape (probed 2026-10-30) is
 * `status` PENDING (approved, single phase) or FAILED with `failure_reason`, id `transaction_id`;
 * the documented shape is `process_result` APPROVED / DECLINED, id `card_transaction_id`. Both are
 * read, and a transactions list item (documented `status` + `failure_reason`) reads the same way.
 */
export function purchaseResult(t: Json | undefined): RailResult {
  const id = t?.transaction_id ?? t?.card_transaction_id;
  if (!t || typeof id !== "string") return { status: "unknown", detail: "no card transaction" };
  const railRef = id;
  const declined = t.status === "FAILED" || t.process_result === "DECLINED";
  if (declined) {
    const why = typeof t.failure_reason === "string" ? t.failure_reason : "no reason given";
    return { status: "failed", railRef, detail: redact(`declined by card: ${why.slice(0, 60)}`) };
  }
  const s = String(t.status ?? t.process_result ?? "");
  // The documented list statuses: APPROVED, CLEARED, EXPIRED, FAILED, PENDING, REVERSED.
  if (s === "REVERSED" || s === "EXPIRED") {
    return { status: "failed", railRef, detail: `card purchase ${s.toLowerCase()}` };
  }
  if (["PENDING", "APPROVED", "CLEARED"].includes(s)) {
    return { status: "succeeded", railRef, detail: `approved by card (${s})` };
  }
  return { status: "unknown", railRef, detail: redact(`card answered ${s.slice(0, 30)}`) };
}

const TXNS = "/api/v1/issuing/transactions";

export class AirwallexCards implements RailAdapter, CardControls {
  readonly rail = "airwallex_card" as const;
  /** Every card this adapter issued or adopted: freezeAll() freezes each. */
  private readonly cards = new Set<string>();
  private current: string | undefined;
  private readonly merchants = new Map<string, Payee>();
  /** Idempotency key -> card transaction id, and the last answer under that key. */
  private readonly purchases = new Map<string, { txId?: string; result: RailResult }>();

  constructor(
    private readonly client: AirwallexClient,
    private readonly opts: AirwallexCardsOptions = {},
  ) {}

  /** The card purchases go on (after issue()). */
  get cardId(): string | undefined {
    return this.current;
  }

  private log(line: string): void {
    this.opts.log?.(redact(line));
  }

  /**
   * The warrant's card: `cardId` if given (must be ACTIVE), else the account's first ACTIVE card,
   * else a new virtual card. An existing card's controls are brought in line with the warrant when
   * they differ; if the API refuses, the answer says so (control still enforces the warrant).
   */
  async issue(w: CardWarrant, how: IssueOptions): Promise<IssuedCard> {
    const want = cardControls(w);
    for (const p of cardPayees(w)) this.merchants.set(p.routingRef, p);

    let source: IssuedCard["source"];
    let card: Json;
    if (how.cardId) {
      card = await this.getCard(how.cardId);
      if (card.card_status !== "ACTIVE") {
        throw new Error(`card ${how.cardId} is ${String(card.card_status)}, not ACTIVE`);
      }
      source = "given";
    } else {
      const listed = await this.client.call(
        "GET",
        "/api/v1/issuing/cards?card_status=ACTIVE&page_size=10",
      );
      if (listed.status !== 200) throw new Error(`card list refused: ${codeOf(listed.body)}`);
      const items: Json[] = Array.isArray(listed.body?.items) ? listed.body.items : [];
      const first = items.find((c) => c.brand === "VISA") ?? items[0];
      if (first && typeof first.card_id === "string") {
        card = await this.getCard(first.card_id);
        source = "listed";
      } else {
        card = await this.createCard(want, how);
        source = "created";
      }
    }
    const cardId = String(card.card_id);
    this.cards.add(cardId);
    this.current = cardId;

    let controls = "mirrored";
    const diff = source === "created" ? [] : controlsDiffer(card.authorization_controls, want);
    if (diff.length) {
      const r = await this.client.call(
        "POST",
        `/api/v1/issuing/cards/${encodeURIComponent(cardId)}/update`,
        { authorization_controls: want },
      );
      controls =
        r.status === 200
          ? "updated"
          : `not mirrored: ${diff.join(", ")} differ and the update was refused (${codeOf(r.body)})`;
    }
    this.log(`card ${cardId} ${source}, controls ${controls}`);
    return { cardId, source, controls };
  }

  private async getCard(id: string): Promise<Json> {
    const r = await this.client.call("GET", `/api/v1/issuing/cards/${encodeURIComponent(id)}`);
    if (r.status !== 200 || typeof r.body?.card_id !== "string") {
      throw new Error(`card ${id} not found (${codeOf(r.body)})`);
    }
    return r.body;
  }

  private async createCard(controls: Json, how: IssueOptions): Promise<Json> {
    const cardholderId = how.cardholderId ?? (await this.cardholder());
    let r: { status: number; body: any };
    try {
      r = await this.client.call("POST", "/api/v1/issuing/cards/create", {
        request_id: how.requestId,
        cardholder_id: cardholderId,
        created_by: this.opts.createdBy ?? "Warrant owner",
        form_factor: "VIRTUAL",
        is_personalized: false,
        program: { purpose: "COMMERCIAL" },
        authorization_controls: controls,
      });
    } catch (e) {
      if (e instanceof AirwallexTimeout) {
        // Never resend a card create (a reused request_id is refused): find it, then retry issue().
        throw new Error("card create timed out: list the cardholder's cards before trying again", {
          cause: e,
        });
      }
      throw e;
    }
    if (![200, 201, 202].includes(r.status) || typeof r.body?.card_id !== "string") {
      throw new Error(`card create refused: ${codeOf(r.body)}`);
    }
    return r.body;
  }

  /** The account's first cardholder, or a new DELEGATE one. */
  private async cardholder(): Promise<string> {
    const listed = await this.client.call("GET", "/api/v1/issuing/cardholders?page_size=10");
    const items: Json[] = Array.isArray(listed.body?.items) ? listed.body.items : [];
    const found = items.find((h) => typeof h.cardholder_id === "string");
    if (listed.status === 200 && found) return found.cardholder_id as string;
    const r = await this.client.call("POST", "/api/v1/issuing/cardholders/create", {
      type: "DELEGATE",
      email: this.opts.cardholderEmail ?? "treasury@warrant.invalid",
    });
    if (r.status !== 201 || typeof r.body?.cardholder_id !== "string") {
      throw new Error(`cardholder create refused: ${codeOf(r.body)}`);
    }
    return r.body.cardholder_id;
  }

  async execute(i: RailInstruction): Promise<RailResult> {
    const result = await this.purchase(i);
    this.log(`purchase ${i.idempotencyKey}: ${result.status} ${result.detail ?? ""}`.trim());
    return result;
  }

  private async purchase(i: RailInstruction): Promise<RailResult> {
    const card = this.current;
    if (!card) return { status: "failed", detail: "no card issued for this warrant" };
    const merchant = this.merchants.get(i.routingRef);
    if (!merchant)
      return { status: "failed", detail: "payee is not a card merchant on the warrant" };
    // The simulator takes no request_id, so a resend would charge twice: a key used before is
    // answered from what we know, never sent again.
    const prior = this.purchases.get(i.idempotencyKey);
    if (prior) {
      return prior.result.status === "unknown" ? this.getStatus(i.idempotencyKey) : prior.result;
    }
    this.purchases.set(i.idempotencyKey, {
      result: { status: "unknown", detail: "sent, no answer yet" },
    });
    let result: RailResult;
    try {
      const r = await this.client.call("POST", "/api/v1/simulation/issuing/create", {
        card_id: card,
        transaction_amount: Number(major(i.amount.cents)),
        transaction_currency: i.amount.currency,
        merchant_info: merchant.displayName.slice(0, 100),
        ...(merchant.merchantCategoryCode
          ? { merchant_category_code: merchant.merchantCategoryCode }
          : {}),
        single_phase: true,
      });
      if (r.status === 200 || r.status === 201) result = purchaseResult(r.body);
      else if (r.status >= 500) result = { status: "unknown", detail: "card service error" };
      else result = { status: "failed", detail: `purchase refused: ${codeOf(r.body)}` };
    } catch (e) {
      result = {
        status: "unknown",
        detail: e instanceof AirwallexTimeout ? "timed out" : "network error",
      };
    }
    this.purchases.set(i.idempotencyKey, {
      ...(result.railRef ? { txId: result.railRef } : {}),
      result,
    });
    return result;
  }

  async getStatus(idempotencyKey: string): Promise<RailResult> {
    const known = this.purchases.get(idempotencyKey);
    if (!known) return { status: "failed", detail: "no card purchase with this key" };
    if (!known.txId || !this.current) {
      // Sent, but no transaction id came back: the simulator keeps no request_id to search by.
      return known.result.status === "unknown"
        ? { status: "unknown", detail: "no transaction id to look up" }
        : known.result;
    }
    try {
      const q = `card_id=${encodeURIComponent(this.current)}&page_size=100`;
      const r = await this.client.call("GET", `${TXNS}?${q}`);
      const items: Json[] = Array.isArray(r.body?.items) ? r.body.items : [];
      const found = items.find(
        (t) => t.transaction_id === known.txId || t.card_transaction_id === known.txId,
      );
      // UNVERIFIED whether the real list shows pending and declined purchases: fall back to the
      // purchase's own answer.
      const result = found ? purchaseResult(found) : known.result;
      this.purchases.set(idempotencyKey, { txId: known.txId, result });
      return result;
    } catch {
      return { status: "unknown", detail: "lookup failed" };
    }
  }

  /** Every card this adapter issued or adopted goes INACTIVE. Throws if any could not be. */
  async freezeAll(): Promise<{ frozenCardIds: string[] }> {
    const frozen: string[] = [];
    const failed: string[] = [];
    await Promise.all(
      [...this.cards].map(async (id) => {
        try {
          const r = await this.client.call(
            "POST",
            `/api/v1/issuing/cards/${encodeURIComponent(id)}/update`,
            { card_status: "INACTIVE" },
          );
          if (r.status === 200 && r.body?.card_status === "INACTIVE") frozen.push(id);
          else failed.push(`${id} (${codeOf(r.body)})`);
        } catch (e) {
          failed.push(`${id} (${e instanceof AirwallexTimeout ? "timed out" : "network error"})`);
        }
      }),
    );
    this.log(`froze ${frozen.length} card(s)${failed.length ? `, failed ${failed.length}` : ""}`);
    if (failed.length) {
      throw new Error(redact(`froze ${frozen.length}, could not freeze ${failed.join(", ")}`));
    }
    return { frozenCardIds: frozen };
  }
}

/** For a scene or the owner: the limits the card itself reports (`GET /cards/{id}/limits`). */
export async function cardLimits(
  client: AirwallexClient,
  cardId: string,
): Promise<{ interval: string; amount: Money; remaining: Money }[]> {
  const r = await client.call("GET", `/api/v1/issuing/cards/${encodeURIComponent(cardId)}/limits`);
  const ccy = r.body?.currency as Money["currency"];
  const rows: Json[] = Array.isArray(r.body?.limits) ? r.body.limits : [];
  return rows.map((l) => ({
    interval: String(l.interval),
    amount: { currency: ccy, cents: cents(l.amount) ?? 0 },
    remaining: { currency: ccy, cents: cents(l.remaining) ?? 0 },
  }));
}
