// Mock Airwallex: auth, DELEGATE cardholders, virtual cards (freeze), simulated single-phase
// transactions, a transactions list, an opt-in wallet with INSUFFICIENT_FUNDS declines, simulated
// deposits and FX quotes.
// Shapes were checked against the real sandbox on 2026-10-30 (legacy shape, no x-api-version).
// Anything not observed there is marked ASSUMED or UNVERIFIED.
import { randomUUID } from "node:crypto";
import { createServer } from "node:http";
import type { IncomingHttpHeaders, Server, ServerResponse } from "node:http";

/* eslint-disable @typescript-eslint/no-explicit-any */
type Json = Record<string, any>;
interface Out {
  status: number;
  body: unknown;
}

// A fault hits the next `times` (default 1) requests with this exact method and path.
export type Fault = { method: string; path: string; times?: number } & (
  | { kind: "5xx"; status?: number } // fails before any work: no side effect
  | { kind: "duplicate" } // runs the request twice, returns the second response
  | { kind: "timeout-after"; ms: number } // does the work, then holds the response for ms
);

interface CardRec {
  card: Json;
  limits: { interval: string; cents: number }[];
  currency: string;
  currencies: string[]; // allowed_currencies, empty = all
  categories: string[]; // allowed_merchant_categories, empty = all
  spent: number;
}

export interface AirwallexOptions {
  port?: number;
  /** Seed wallet in major units per currency. Without it there is no wallet and no funds check. */
  balances?: Record<string, number>;
  /**
   * FX rates as decimal strings, one per market pair (BASEQUOTE): { EURUSD: "1.122579" } means 1 EUR is
   * 1.122579 USD. At most 6 decimals. One entry serves both directions.
   */
  rates?: Record<string, string>;
  /** Clock in ms, so tests can expire quotes without sleeping. */
  now?: () => number;
}

interface QuoteRec {
  pair: string;
  micro: number;
  buyCurrency: string;
  sellCurrency: string;
  validToMs: number;
}

export interface AirwallexMock {
  url: string;
  server: Server;
  close(): Promise<void>;
  fault(f: Fault): void;
  state: {
    cardholders: Map<string, Json>;
    cards: Map<string, CardRec>;
    transactions: Json[];
    deposits: Json[];
    quotes: Map<string, QuoteRec>;
    rates: Map<string, number>; // pair -> rate in integer micro-units
  };
}

const INTERVALS = ["PER_TRANSACTION", "DAILY", "WEEKLY", "MONTHLY", "ALL_TIME"];
const err = (status: number, code: string, message: string, source?: string): Out => ({
  status,
  body: { code, message, source: source ?? "" }, // sandbox error bodies always carry source, "" when empty
});
const stamp = () => new Date().toISOString().replace("Z", "+0000");
const strList = (x: unknown): string[] | null =>
  x === undefined || x === null
    ? []
    : Array.isArray(x) && x.every((s) => typeof s === "string")
      ? x
      : null;
const mask = (n: number) => "************" + String(1000 + (n % 9000));

/** Money in cents (at least `min`), parsed from the decimal string. No exponent, max 2 decimals, no float math. */
function toCents(x: unknown, min = 1): number | null {
  if (typeof x !== "number") return null;
  const m = /^(\d+)(?:\.(\d{1,2}))?$/.exec(String(x));
  if (!m) return null;
  const cents = Number(m[1] + (m[2] ?? "").padEnd(2, "0"));
  return Number.isSafeInteger(cents) && cents >= min ? cents : null;
}

/** Non-negative integer query param in [min, max], the default when absent, null when malformed. */
function intParam(q: URLSearchParams, name: string, dflt: number, min: number, max: number) {
  const v = q.get(name);
  if (v === null) return dflt;
  return /^\d+$/.test(v) && Number(v) >= min && Number(v) <= max ? Number(v) : null;
}

const VALIDITY_MS: Record<string, number> = {
  MIN_1: 60_000,
  MIN_15: 900_000,
  MIN_30: 1_800_000,
  HR_1: 3_600_000,
  HR_4: 14_400_000,
  HR_8: 28_800_000,
  HR_24: 86_400_000,
};
const isCcy = (x: unknown): x is string => typeof x === "string" && /^[A-Z]{3}$/.test(x);
// Sandbox list and quote timestamps have no milliseconds: 2026-10-30T20:08:32+0000.
const sec = (ms: number) => new Date(ms).toISOString().slice(0, 19) + "+0000";

/** A rate decimal string as integer micro-units: positive, at most 6 decimals, no exponent. */
function toMicro(x: unknown): number | null {
  if (typeof x !== "string") return null;
  const m = /^(\d+)(?:\.(\d{1,6}))?$/.exec(x);
  if (!m) return null;
  const micro = Number(m[1] + (m[2] ?? "").padEnd(6, "0"));
  return Number.isSafeInteger(micro) && micro > 0 ? micro : null;
}

/**
 * The other side of a deal, in cents, from the dealt side. A pair is BASEQUOTE and its rate is QUOTE per
 * 1 BASE (the sandbox's market convention: EURUSD 1.122579 is 1.122579 USD per EUR). Base to quote
 * multiplies by the rate, quote to base divides. Integer math only (BigInt), rounded to the NEAREST cent
 * with ties up. Nearest is checked against five real sandbox conversions (2026-10-30): floor and ceil each
 * get at least one wrong. The tie direction is ASSUMED. Whole amounts only: 2-decimal currencies.
 */
function convert(cents: number, fromBase: boolean, micro: number): number | null {
  const n = BigInt(cents);
  const r = BigInt(micro);
  const [num, den] = fromBase ? [n * r, 1_000_000n] : [n * 1_000_000n, r];
  const out = (2n * num + den) / (2n * den);
  return out <= BigInt(Number.MAX_SAFE_INTEGER) ? Number(out) : null;
}

export async function startAirwallexMock({
  port = 0,
  balances = {},
  rates = {},
  now = Date.now,
}: AirwallexOptions = {}): Promise<AirwallexMock> {
  const state: AirwallexMock["state"] = {
    cardholders: new Map(),
    cards: new Map(),
    transactions: [],
    deposits: [],
    quotes: new Map(),
    rates: new Map(),
  };
  for (const [pair, rate] of Object.entries(rates)) {
    const micro = toMicro(rate);
    if (!/^[A-Z]{6}$/.test(pair) || micro === null) {
      throw new Error(`Invalid rates seed for ${pair}: ${String(rate)}`);
    }
    state.rates.set(pair, micro);
  }
  // Wallet in cents. Money moves like the sandbox (probed 2026-10-30): an approval takes funds from
  // available into reserved, so total is unchanged. pending_amount stays 0 (no deposits modelled).
  const wallet = new Map<string, { available: number; reserved: number }>();
  for (const [ccy, amount] of Object.entries(balances)) {
    const cents = toCents(amount, 0);
    if (cents === null) throw new Error("Invalid balances seed for " + ccy + ": " + String(amount));
    wallet.set(ccy, { available: cents, reserved: 0 });
  }
  const tokens = new Set<string>();
  const faults: { f: Fault; left: number }[] = [];
  const requestIds = new Set<string>();

  function createCard(b: Json): Out {
    // Airwallex never replays a card create: a reused request_id is 400 whatever the body (sandbox,
    // 2026-10-30, with the same body and with a different one).
    if (requestIds.has(b.request_id)) {
      return err(
        400,
        "invalid_argument",
        "The provided ID is already associated with a previous request",
        "request_id",
      );
    }
    const bad = (source: string) => err(400, "invalid_argument", `Invalid ${source}`, source);
    if (typeof b.request_id !== "string" || !b.request_id) return bad("request_id");
    // Unknown cardholder is a 400 here: ASSUMED, not probed.
    if (!state.cardholders.has(b.cardholder_id)) return bad("cardholder_id");
    if (typeof b.created_by !== "string" || !b.created_by) return bad("created_by");
    if (b.form_factor !== "VIRTUAL") return bad("form_factor"); // physical cards: out of scope
    if (b.is_personalized !== false) return bad("is_personalized"); // DELEGATE holds non-personalized only
    const ctl = b.authorization_controls ?? {};
    const raw_limits: Json[] = ctl.transaction_limits?.limits ?? [];
    const limits: { interval: string; cents: number }[] = [];
    for (const l of raw_limits) {
      const cents = toCents(l.amount);
      if (cents === null || !INTERVALS.includes(l.interval)) return bad("authorization_controls");
      limits.push({ interval: l.interval, cents });
    }
    if (!limits.length) return bad("authorization_controls");
    const currencies = strList(ctl.allowed_currencies);
    const categories = strList(ctl.allowed_merchant_categories);
    if (!currencies || !categories) return bad("authorization_controls");
    const n = state.cards.size;
    const card = {
      alert_settings: { low_remaining_transaction_limit: { enabled: true, percent: 10 } },
      authorization_controls: {
        allowed_currencies: currencies,
        allowed_merchant_categories: categories,
        allowed_transaction_count: ctl.allowed_transaction_count ?? "MULTIPLE",
        blocked_transaction_usages: [],
        transaction_limits: {
          currency: ctl.transaction_limits.currency ?? "USD",
          limits: limits.map((l) => ({ amount: l.cents / 100, interval: l.interval })),
        },
      },
      brand: "VISA",
      card_id: randomUUID(),
      card_number: mask(n), // last 4 only; the mock never holds a full number
      card_status: "ACTIVE", // virtual cards are ACTIVE in the create response (sandbox, 2026-10-30)
      cardholder_id: b.cardholder_id,
      created_at: stamp(),
      created_by: b.created_by,
      form_factor: "VIRTUAL",
      is_personalized: false,
      name_on_card: "Sandbox Business",
      program: {
        purpose: b.program?.purpose ?? "COMMERCIAL",
        sub_type: "GOOD_FUNDS_CREDIT",
        type: "CREDIT",
      },
      purpose: "BUSINESS_EXPENSES",
      request_id: b.request_id,
      updated_at: stamp(),
    };
    state.cards.set(card.card_id, {
      card: {
        ...card,
        card_version: 1,
        all_card_versions: [
          {
            card_number: card.card_number,
            card_status: "ACTIVE",
            card_version: 1,
            created_at: card.created_at,
          },
        ],
      },
      limits,
      currency: card.authorization_controls.transaction_limits.currency,
      currencies,
      categories,
      spent: 0,
    });
    requestIds.add(b.request_id);
    return { status: 201, body: card };
  }

  function simulate(b: Json): Out {
    // No idempotency here: the real simulator takes no request_id, so a duplicated or replayed call
    // charges twice. That is the behaviour control must survive, so do not add a dedupe.
    // Two-phase (authorize, then capture or reverse) arrives with the capture/reverse endpoints.
    // The sandbox default is single_phase=false, so an omitted flag lands here too.
    if (b.single_phase !== true) {
      return err(
        400,
        "invalid_argument",
        "This mock supports single_phase=true only",
        "single_phase",
      );
    }
    const rec = state.cards.get(b.card_id);
    if (!rec) return err(404, "resource_not_found", "Card not found", "card_id"); // ASSUMED code
    const cents = toCents(b.transaction_amount);
    if (cents === null)
      return err(400, "invalid_argument", "Invalid transaction_amount", "transaction_amount");
    const ccy = b.transaction_currency;
    if (typeof ccy !== "string") {
      return err(400, "invalid_argument", "Invalid transaction_currency", "transaction_currency");
    }
    // Declines are 200 + FAILED, like the sandbox LIMIT_EXCEEDED. Check order is ASSUMED: card status,
    // currency, merchant category, limits, then funds. A frozen card is CARD_INACTIVE (probed).
    let failure: string | null = rec.card.card_status === "ACTIVE" ? null : "CARD_INACTIVE";
    if (!failure && rec.currencies.length && !rec.currencies.includes(ccy)) {
      failure = "CURRENCY_NOT_ALLOWED";
    }
    if (!failure && ccy !== rec.currency) {
      return err(
        400,
        "invalid_argument",
        "Mock supports the limit currency only",
        "transaction_currency",
      );
    }
    const mcc = String(b.merchant_category_code ?? "7531"); // 7531 is the sandbox default merchant
    if (!failure && rec.categories.length && !rec.categories.includes(mcc)) {
      failure = "MERCHANT_CATEGORY_NOT_ALLOWED";
    }
    // DAILY/WEEKLY/MONTHLY are cumulative with no reset: the mock has no clock rollover.
    const over = rec.limits.some((l) =>
      l.interval === "PER_TRANSACTION" ? cents > l.cents : rec.spent + cents > l.cents,
    );
    if (!failure && over) failure = "LIMIT_EXCEEDED";
    // INSUFFICIENT_FUNDS is inclusive (exact balance passes). Only seeded currencies are checked: an
    // unseeded currency has unlimited funds (ASSUMED convenience; the real name is from the kit).
    const funds = wallet.get(ccy);
    if (!failure && funds && cents > funds.available) failure = "INSUFFICIENT_FUNDS";
    if (!failure) {
      rec.spent += cents;
      if (funds) {
        funds.available -= cents;
        funds.reserved += cents;
      }
    }
    const amount = -(cents / 100);
    const txn = {
      transaction_id: randomUUID(),
      transaction_type: "CLEARING", // single_phase=true approval verified; declined is from the docs
      transaction_date: stamp(),
      posted_date: stamp(),
      card_id: b.card_id,
      transaction_amount: amount,
      transaction_currency: ccy,
      billing_amount: amount,
      billing_currency: ccy,
      merchant: {
        name: "AIRPRO_TX_GENERATOR",
        city: "A_CITY_NAME",
        country: "AUS",
        category_code: mcc,
      },
      auth_code: randomUUID().slice(0, 6).toUpperCase(),
      masked_card_number: rec.card.card_number,
      status: failure ? "FAILED" : "PENDING", // an approved single_phase is PENDING, not CLEARED
      ...(failure ? { failure_reason: failure } : {}),
    };
    state.transactions.push(txn);
    return { status: 200, body: txn };
  }

  // The sandbox answered a simulated deposit with PENDING and moved the balance within about a minute
  // (probed 2026-10-30; pending_amount never moved). The mock credits available at once, answers PENDING,
  // and lists the deposit as SETTLED. A currency with no wallet gets one, so from then on card purchases
  // in it are funds-checked. The request body is ASSUMED (the MCP only sends amount and global_account_id)
  // and so are the 201 and the {has_more, items} list shape (the MCP printed a bare array).
  function createDeposit(b: Json): Out {
    const bad = (source: string) => err(400, "invalid_argument", `Invalid ${source}`, source);
    const cents = toCents(b.amount);
    if (cents === null) return bad("amount");
    if (!isCcy(b.currency)) return bad("currency");
    for (const k of ["reference", "global_account_id"]) {
      if (b[k] !== undefined && typeof b[k] !== "string") return bad(k);
    }
    const ccy: string = b.currency;
    const ms = now();
    const id = randomUUID();
    const w = wallet.get(ccy) ?? { available: 0, reserved: 0 };
    w.available += cents;
    wallet.set(ccy, w);
    state.deposits.push({
      id,
      amount: cents / 100,
      created_at: sec(ms),
      currency: ccy,
      fee: { amount: 0, currency: ccy },
      ...(b.global_account_id === undefined ? {} : { global_account_id: b.global_account_id }),
      payer: {},
      provider_transaction_id: randomUUID(),
      ...(b.reference === undefined ? {} : { reference: b.reference }),
      settled_at: sec(ms),
      status: "SETTLED",
      type: "BANK_TRANSFER",
    });
    const created_at = new Date(ms).toISOString().replace("Z", "+00:00");
    return {
      status: 201,
      body: { deposit_id: id, amount: cents / 100, currency: ccy, status: "PENDING", created_at },
    };
  }

  // Quote shape probed 2026-10-30 (EURUSD, sell 10 USD, MIN_1: usage MULTI_USE, 60 s, 6-decimal rate).
  // Trimmed: awx_rate, mid_rate and rate_details are left out. valid_to_at is inclusive.
  function createQuote(b: Json): Out {
    const bad = (source: string) => err(400, "invalid_argument", `Invalid ${source}`, source);
    if (!isCcy(b.buy_currency)) return bad("buy_currency");
    if (!isCcy(b.sell_currency)) return bad("sell_currency");
    const validityMs =
      typeof b.validity === "string" && Object.hasOwn(VALIDITY_MS, b.validity)
        ? VALIDITY_MS[b.validity]
        : undefined;
    if (validityMs === undefined) return bad("validity");
    const sellDealt = b.sell_amount !== undefined;
    if (sellDealt === (b.buy_amount !== undefined)) return bad("sell_amount"); // exactly one amount
    const field = sellDealt ? "sell_amount" : "buy_amount";
    const dealt = toCents(b[field]);
    if (dealt === null) return bad(field);
    const dealtCcy: string = sellDealt ? b.sell_currency : b.buy_currency;
    const rate =
      b.buy_currency === b.sell_currency ? null : rateFor(b.sell_currency, b.buy_currency);
    // unsupported_currency is a documented code; using it for a missing rate is ASSUMED.
    if (!rate) return err(400, "unsupported_currency", "No rate for this pair", "buy_currency");
    const other = convert(dealt, dealtCcy === rate.base, rate.micro);
    if (other === null) return err(400, "amount_above_limit", "Amount too large", field);
    const [buy, sell] = sellDealt ? [other, dealt] : [dealt, other];
    const ms = now();
    const quote_id = randomUUID();
    state.quotes.set(quote_id, {
      pair: rate.pair,
      micro: rate.micro,
      buyCurrency: b.buy_currency,
      sellCurrency: b.sell_currency,
      validToMs: ms + validityMs,
    });
    return {
      status: 200, // the sandbox answers a quote 200, while deposits and conversions are 201
      body: {
        buy_amount: buy / 100,
        buy_currency: b.buy_currency,
        client_rate: rate.micro / 1_000_000, // same double as Number("1.122579"): exact integers divided once
        // The sandbox date followed the account's local day (a 06:11Z conversion showed the day before);
        // the mock uses the UTC date: ASSUMED.
        conversion_date: new Date(ms).toISOString().slice(0, 10),
        currency_pair: rate.pair,
        dealt_currency: dealtCcy,
        quote_id,
        sell_amount: sell / 100,
        sell_currency: b.sell_currency,
        usage: "MULTI_USE",
        valid_from_at: sec(ms),
        valid_to_at: sec(ms + validityMs),
        validity: b.validity,
      },
    };
  }

  // Sandbox 2026-10-30: giving only one of page_num / page_size is 400 with this exact message and an empty
  // source. Neither (everything), the paging limits, newest first and {has_more, items} are ASSUMED: the
  // MCP printed a bare array and no real GET with both params has been captured yet.
  function listDeposits(q: URLSearchParams): Out {
    const all = [...state.deposits].reverse();
    if (!q.has("page_num") && !q.has("page_size"))
      return { status: 200, body: { has_more: false, items: all } };
    if (!q.has("page_num") || !q.has("page_size")) {
      return err(400, "invalid_argument", "both page_num and page_size need to be filled");
    }
    const pageNum = intParam(q, "page_num", 0, 0, Number.MAX_SAFE_INTEGER);
    if (pageNum === null) return err(400, "invalid_argument", "Invalid page_num", "page_num");
    const pageSize = intParam(q, "page_size", 10, 1, 1000);
    if (pageSize === null) return err(400, "invalid_argument", "Invalid page_size", "page_size");
    const end = (pageNum + 1) * pageSize;
    return {
      status: 200,
      body: { has_more: all.length > end, items: all.slice(pageNum * pageSize, end) },
    };
  }

  function rateFor(sell: string, buy: string) {
    for (const pair of [sell + buy, buy + sell]) {
      const micro = state.rates.get(pair);
      if (micro !== undefined) return { pair, micro, base: pair.slice(0, 3) };
    }
    return null;
  }

  function updateCard(id: string, b: Json): Out {
    const rec = state.cards.get(id);
    if (!rec) return err(404, "resource_not_found", "Card not found"); // ASSUMED code
    // Freeze and unfreeze only. The real endpoint is a partial update (limits, nickname, ...); here any
    // other key is a 400 (ASSUMED) rather than silently ignored, and CLOSED is out of scope.
    const other = Object.keys(b).find((k) => k !== "card_status");
    if (other) return err(400, "invalid_argument", "Only card_status can be updated", other);
    if (b.card_status !== "ACTIVE" && b.card_status !== "INACTIVE") {
      return err(400, "invalid_argument", "card_status must be ACTIVE or INACTIVE", "card_status");
    }
    rec.card.card_status = b.card_status;
    rec.card.all_card_versions[0].card_status = b.card_status; // one version, updated in place (probed)
    // The sandbox bumped updated_at on unfreeze but not on freeze; the mock always bumps (ASSUMED).
    rec.card.updated_at = stamp();
    // The update response is the create shape, without card_version / all_card_versions (probed).
    const view = { ...rec.card };
    delete view.card_version;
    delete view.all_card_versions;
    return { status: 200, body: view };
  }

  // Legacy list. Confirmed against the sandbox on 2026-10-30 (our own REST key): the body is
  // {has_more, items}, and a page_size below 10 is 400 BELOW_MIN_PAGE_SIZE with an empty source.
  // page_num from 0 is from the docs. Newest first, default page_size 10 and max 100 are ASSUMED.
  // UNVERIFIED: the real list's item shape, and whether it shows pending and declined transactions. An
  // earlier probe seemed to show an empty list, but it used a key whose account has no cards at all (the
  // cards we probed live in the MCP's account), so it said nothing. The mock lists every simulated
  // transaction, with the simulate response's shape (ASSUMED). Use the simulate response for pending state.
  function listTransactions(q: URLSearchParams): Out {
    const pageNum = intParam(q, "page_num", 0, 0, Number.MAX_SAFE_INTEGER);
    if (pageNum === null) return err(400, "invalid_argument", "Invalid page_num", "page_num");
    const rawSize = q.get("page_size");
    if (rawSize !== null && /^-?\d+$/.test(rawSize) && Number(rawSize) < 10) {
      return err(400, "invalid_argument", "BELOW_MIN_PAGE_SIZE");
    }
    const pageSize = intParam(q, "page_size", 10, 10, 100);
    if (pageSize === null) return err(400, "invalid_argument", "Invalid page_size", "page_size");
    const cardId = q.get("card_id");
    const all = state.transactions.filter((t) => cardId === null || t.card_id === cardId).reverse();
    const end = (pageNum + 1) * pageSize;
    return {
      status: 200,
      body: { has_more: all.length > end, items: all.slice(pageNum * pageSize, end) },
    };
  }

  // GET /issuing/cards: the summary list. Shape probed 2026-10-30: {has_more, items}, each item brand, card_id,
  // masked card_number, card_status, cardholder_id, created_at, updated_at, oldest first (two cards). No
  // request_id and no authorization_controls, so a caller unsure whether a create landed must retrieve each
  // candidate by id and compare its request_id (the list has no request_id filter). cardholder_id and
  // card_status are documented filters.
  // CONFIRMED 2026-10-30 (through the MCP: create and list in the same account): a card created seconds
  // earlier was in the real list at once. So an empty answer here does mean "no such card yet" for a create
  // that finished. Not mirrored: the real list timestamps ran about 0.2 s after the create response; the mock
  // returns the same values.
  // ASSUMED: page_size 10 to 200 with the BELOW_MIN_PAGE_SIZE message of the other lists, and no nick_name or
  // date filters.
  function listCards(q: URLSearchParams): Out {
    const num = (k: string, dflt: number) =>
      q.has(k) ? (/^\d+$/.test(q.get(k) ?? "") ? Number(q.get(k)) : null) : dflt;
    const pageNum = num("page_num", 0);
    if (pageNum === null) return err(400, "invalid_argument", "Invalid page_num", "page_num");
    const rawSize = q.get("page_size");
    if (rawSize !== null && /^-?\d+$/.test(rawSize) && Number(rawSize) < 10) {
      return err(400, "invalid_argument", "BELOW_MIN_PAGE_SIZE");
    }
    const pageSize = num("page_size", 100);
    if (pageSize === null || pageSize > 200) {
      return err(400, "invalid_argument", "Invalid page_size", "page_size");
    }
    const all = [...state.cards.values()]
      .map((r) => r.card)
      .filter((c) => !q.has("cardholder_id") || c.cardholder_id === q.get("cardholder_id"))
      .filter((c) => !q.has("card_status") || c.card_status === q.get("card_status"))
      .map((c) => ({
        brand: c.brand,
        card_id: c.card_id,
        card_number: c.card_number,
        card_status: c.card_status,
        cardholder_id: c.cardholder_id,
        created_at: c.created_at,
        updated_at: c.updated_at,
      }));
    const end = (pageNum + 1) * pageSize;
    return {
      status: 200,
      body: { has_more: all.length > end, items: all.slice(pageNum * pageSize, end) },
    };
  }

  function route(
    method: string,
    path: string,
    query: URLSearchParams,
    headers: IncomingHttpHeaders,
    raw: string,
  ): Out {
    if (method === "POST" && path === "/api/v1/authentication/login") {
      if (!headers["x-client-id"] || !headers["x-api-key"])
        return err(401, "unauthorized", "Missing credentials");
      const token = randomUUID(); // expiry is not enforced
      tokens.add(token);
      return {
        status: 201,
        body: {
          expires_at: new Date(Date.now() + 30 * 60_000).toISOString().replace("Z", "+0000"),
          token,
        },
      };
    }
    const auth = headers.authorization ?? "";
    if (!auth.startsWith("Bearer ") || !tokens.has(auth.slice(7))) {
      return err(401, "unauthorized", "Missing or invalid bearer token");
    }
    let b: Json = {};
    try {
      if (method === "POST" && raw) b = JSON.parse(raw);
    } catch {
      return err(400, "invalid_argument", "Body is not valid JSON");
    }
    const holder = /^\/api\/v1\/issuing\/cardholders\/([^/]+)$/.exec(path);
    const card = /^\/api\/v1\/issuing\/cards\/([^/]+?)(\/limits)?$/.exec(path);
    if (method === "POST" && path === "/api/v1/issuing/cardholders/create") {
      if (b.type !== "DELEGATE")
        return err(400, "invalid_argument", "Only DELEGATE cardholders are supported", "type");
      if (typeof b.email !== "string" || !b.email.includes("@"))
        return err(400, "invalid_argument", "Invalid email", "email");
      const rec = {
        cardholder_id: randomUUID(),
        email: b.email,
        status: "READY",
        type: "DELEGATE",
      };
      state.cardholders.set(rec.cardholder_id, rec);
      return { status: 201, body: rec };
    }
    if (method === "GET" && holder) {
      const rec = state.cardholders.get(holder[1] ?? "");
      return rec
        ? { status: 200, body: rec }
        : err(404, "resource_not_found", "Cardholder not found"); // ASSUMED code
    }
    if (method === "POST" && path === "/api/v1/issuing/cards/create") return createCard(b);
    if (method === "GET" && path === "/api/v1/issuing/cards") return listCards(query);
    const update = /^\/api\/v1\/issuing\/cards\/([^/]+)\/update$/.exec(path);
    if (method === "POST" && update) return updateCard(update[1] ?? "", b);
    if (method === "GET" && path === "/api/v1/issuing/transactions") return listTransactions(query);
    if (method === "GET" && path === "/api/v1/balances/current") {
      // The real endpoint lists every currency, zero rows included; the mock lists only seeded ones.
      const rows = [...wallet].map(([currency, w]) => ({
        available_amount: w.available / 100,
        currency,
        pending_amount: 0,
        reserved_amount: w.reserved / 100,
        total_amount: (w.available + w.reserved) / 100,
        prepayment_amount: 0,
        account_type: "cash",
      }));
      return { status: 200, body: rows };
    }
    if (method === "GET" && card) {
      const rec = state.cards.get(card[1] ?? "");
      if (!rec) return err(404, "resource_not_found", "Card not found"); // ASSUMED code
      if (!card[2]) return { status: 200, body: rec.card };
      const limits = rec.limits.map((l) => ({
        amount: l.cents / 100,
        interval: l.interval,
        remaining: (l.interval === "PER_TRANSACTION" ? l.cents : l.cents - rec.spent) / 100,
      }));
      return { status: 200, body: { currency: rec.currency, limits } };
    }
    if (method === "POST" && path === "/api/v1/simulation/issuing/create") return simulate(b);
    if (method === "POST" && path === "/api/v1/simulation/deposit/create") return createDeposit(b);
    if (method === "GET" && path === "/api/v1/deposits") return listDeposits(query);
    if (method === "POST" && path === "/api/v1/fx/quotes/create") return createQuote(b);
    return err(404, "resource_not_found", `No route for ${method} ${path}`);
  }

  const send = (res: ServerResponse, out: Out) => {
    if (res.destroyed) return;
    res.writeHead(out.status, { "content-type": "application/json" }).end(JSON.stringify(out.body));
  };

  const server = createServer(async (req, res) => {
    const chunks: Buffer[] = [];
    for await (const c of req) chunks.push(c as Buffer);
    const raw = Buffer.concat(chunks).toString();
    const url = new URL(req.url ?? "/", "http://mock");
    const path = url.pathname;
    const method = req.method ?? "GET";
    const hit = faults.find((x) => x.left > 0 && x.f.method === method && x.f.path === path);
    if (hit) hit.left--;
    const f = hit?.f;
    if (f?.kind === "5xx") {
      return send(res, err(f.status ?? 503, "service_unavailable", "Injected fault"));
    }
    let out = route(method, path, url.searchParams, req.headers, raw);
    if (f?.kind === "duplicate") out = route(method, path, url.searchParams, req.headers, raw);
    if (f?.kind === "timeout-after") {
      const timer = setTimeout(() => send(res, out), f.ms);
      res.on("close", () => clearTimeout(timer));
      return;
    }
    send(res, out);
  });

  await new Promise<void>((resolve) => server.listen(port, "127.0.0.1", resolve));
  const addr = server.address() as { port: number };
  return {
    url: `http://127.0.0.1:${addr.port}`,
    server,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
    fault: (f) => void faults.push({ f, left: f.times ?? 1 }),
    state,
  };
}
