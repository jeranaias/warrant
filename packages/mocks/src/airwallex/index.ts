// Mock Airwallex: auth, DELEGATE cardholders, virtual cards (freeze), simulated single-phase
// transactions, a transactions list, an opt-in wallet with INSUFFICIENT_FUNDS declines, simulated
// deposits, FX quotes, conversions, beneficiaries and transfers.
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

interface TransferRec {
  t: Json; // the public body; status is advanced in place
  createdMs: number;
  cents: number;
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
    conversions: Map<string, Json>;
    beneficiaries: Map<string, Json>;
    transfers: Map<string, TransferRec>;
    rates: Map<string, number>; // pair -> rate in integer micro-units
  };
}

const INTERVALS = ["PER_TRANSACTION", "DAILY", "WEEKLY", "MONTHLY", "ALL_TIME"];
const err = (status: number, code: string, message: string, source?: string): Out => ({
  status,
  body: { code, message, source: source ?? "" }, // sandbox error bodies always carry source, "" when empty
});
// FX service errors (conversions) also carry details: [{ code: "correlation_id", message: <uuid> }].
// Probed on the duplicate request_id, insufficient_funds and expired_quote errors.
const fxErr = (status: number, code: string, message: string, source: string): Out => {
  const out = err(status, code, message, source);
  const details = [{ code: "correlation_id", message: randomUUID() }];
  return { ...out, body: { ...(out.body as Json), details } };
};
const stamp = () => new Date().toISOString().replace("Z", "+0000");
const strList = (x: unknown): string[] | null =>
  x === undefined || x === null
    ? []
    : Array.isArray(x) && x.every((s) => typeof s === "string")
      ? x
      : null;
const mask = (n: number) => "************" + String(1000 + (n % 9000));

/** Money in cents (at least `min`), parsed from the decimal string. No exponent, max 2 decimals, no float math. */
function toCents(x: unknown, min = 1, text = false): number | null {
  if (typeof x !== "number" && !(text && typeof x === "string")) return null;
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

// Validation failures on beneficiaries (and transfers) share one envelope, probed 2026-10-30: note there
// is no top-level "source", the failing fields are listed in details.errors.
const VALIDATION_MESSAGE =
  "The request failed our schema validation. Refer to the errors object for erroneous fields, codes and parameters.";
const validationFailed = (errors: { code: string; source: string }[]): Out => ({
  status: 400,
  body: { code: "validation_failed", details: { errors }, message: VALIDATION_MESSAGE },
});

/** Country, two check digits, then 11 to 30 letters or digits, and the ISO 7064 mod-97 check. */
function validIban(x: unknown): x is string {
  if (typeof x !== "string" || !/^[A-Z]{2}\d{2}[A-Z0-9]{11,30}$/.test(x)) return false;
  const digits = (x.slice(4) + x.slice(0, 4)).replace(/[A-Z]/g, (c) =>
    String(c.charCodeAt(0) - 55),
  );
  let rem = 0;
  for (const ch of digits) rem = (rem * 10 + Number(ch)) % 97;
  return rem === 1;
}

// The sandbox adds bank_name from the IBAN (a bank directory). The mock knows only the bank we probed:
// ES + bank code 2100. Any other bank gets no bank_name (a known gap, ASSUMED).
const BANK_NAMES: Record<string, string> = { "ES:2100": "CAIXABANK, S.A." };

// The accepted transfer reasons, from the Airwallex docs.
const TRANSFER_REASONS = [
  "audio_visual_services",
  "bill_payment",
  "business_expenses",
  "construction",
  "donation_charitable_contribution",
  "education_training",
  "freight",
  "goods_purchased",
  "investment_capital",
  "investment_proceeds",
  "living_expenses",
  "loan_credit_repayment",
  "medical_services",
  "pension",
  "professional_business_services",
  "real_estate",
  "taxes",
  "technical_services",
  "transfer_to_own_account",
  "travel",
  "wages_salary",
  "other_services",
];

// The payer profile the sandbox attached to every transfer on 2026-10-30 (fake sandbox data).
const TRANSFER_PAYER = {
  additional_info: {
    business_incorporation_date: "2026-09-05",
    business_registration_number: "123456789",
    business_registration_type: "COMPANY",
  },
  address: {
    city: "Los Angeles",
    country_code: "US",
    postcode: "90001",
    state: "CA",
    street_address: "0241 Alberto Island",
  },
  company_name: "Sandbox Business",
  entity_type: "COMPANY",
};

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
    conversions: new Map(),
    beneficiaries: new Map(),
    transfers: new Map(),
    rates: new Map(),
  };
  const conversionRequests = new Set<string>();
  const transferRequests = new Map<string, string>(); // request_id -> transfer id
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
    // active_to is kept when sent. CONFIRMED 2026-11-03 (retrieve of a sandbox card made with
    // 2026-11-20T00:00:00Z): answered in UTC with milliseconds, `2026-11-20T00:00:00.000+00:00`; a card
    // made without one has none. ASSUMED: an unreadable value is 400, not probed.
    let activeTo: string | undefined;
    if (ctl.active_to !== undefined) {
      const at = typeof ctl.active_to === "string" ? Date.parse(ctl.active_to) : NaN;
      if (Number.isNaN(at)) return bad("authorization_controls");
      activeTo = new Date(at).toISOString().replace("Z", "+00:00");
    }
    const n = state.cards.size;
    const card = {
      alert_settings: { low_remaining_transaction_limit: { enabled: true, percent: 10 } },
      authorization_controls: {
        ...(activeTo ? { active_to: activeTo } : {}),
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

  // Probed 2026-10-30 (our own sandbox key): create is 201 and the conversion is SETTLED at once, with
  // settlement_cutoff_at equal to created_at; a repeated request_id is 400 invalid_argument whatever the
  // body; selling a currency the wallet holds none of is 400 insufficient_funds, source "conversion"
  // (not a SCHEDULED booking); a used-up quote is 400 expired_quote, source "quoteId". Trimmed from the
  // real shape: awx_rate, mid_rate and rate_details. Unprobed and ASSUMED: the order of the checks, that
  // a refused conversion does not consume its request_id, the other error messages and sources, the
  // inclusive balance and quote-expiry edges, the 1.00 minimum for any currency, quote reuse (MULTI_USE
  // was probed, reuse was not), quote_id echoed on the conversion, the UTC conversion_date, and the
  // 7-character short_reference_id alphabet. A currency with no wallet holds zero here, while card
  // purchases treat it as unlimited: a conversion needs real money behind it.
  function createConversion(b: Json): Out {
    const rid = b.request_id;
    if (typeof rid !== "string" || rid === "") {
      return fxErr(400, "field_required", "request_id is required", "request_id");
    }
    if (rid.length > 64) {
      return fxErr(
        400,
        "invalid_argument",
        "request_id must be at most 64 characters",
        "request_id",
      );
    }
    for (const f of ["buy_currency", "sell_currency"]) {
      if (b[f] === undefined) return fxErr(400, "field_required", `${f} is required`, f);
      if (!isCcy(b[f])) return fxErr(400, "invalid_argument", `Invalid ${f}`, f);
    }
    const sellDealt = b.sell_amount !== undefined;
    if (!sellDealt && b.buy_amount === undefined) {
      return fxErr(400, "field_required", "buy_amount or sell_amount is required", "sell_amount");
    }
    if (sellDealt && b.buy_amount !== undefined) {
      return fxErr(
        400,
        "invalid_argument",
        "Set only one of buy_amount and sell_amount",
        "sell_amount",
      );
    }
    const field = sellDealt ? "sell_amount" : "buy_amount";
    const dealt = toCents(b[field], 1, true);
    if (dealt === null) return fxErr(400, "invalid_argument", `Invalid ${field}`, field);
    if (conversionRequests.has(rid)) {
      const message = `request_id '${rid}' has been used in the past. Please use a different request_id for this request`;
      return fxErr(400, "invalid_argument", message, "request_id");
    }
    let rate: { pair: string; micro: number; base: string } | null;
    if (b.quote_id !== undefined) {
      const q = typeof b.quote_id === "string" ? state.quotes.get(b.quote_id) : undefined;
      if (!q) return fxErr(400, "invalid_quote_id", "Invalid quote", "quoteId");
      if (now() > q.validToMs) return fxErr(400, "expired_quote", "Quote has expired", "quoteId");
      if (q.buyCurrency !== b.buy_currency || q.sellCurrency !== b.sell_currency) {
        return fxErr(400, "invalid_argument", "Quote does not match this conversion", "quoteId");
      }
      rate = { pair: q.pair, micro: q.micro, base: q.pair.slice(0, 3) };
    } else {
      rate = b.buy_currency === b.sell_currency ? null : rateFor(b.sell_currency, b.buy_currency);
    }
    if (!rate) return fxErr(400, "unsupported_currency", "No rate for this pair", "buy_currency");
    if (dealt < 100) return fxErr(400, "amount_below_limit", "Amount is below the minimum", field);
    const dealtCcy: string = sellDealt ? b.sell_currency : b.buy_currency;
    const other = convert(dealt, dealtCcy === rate.base, rate.micro);
    if (other === null) return fxErr(400, "amount_above_limit", "Amount too large", field);
    const [buy, sell] = sellDealt ? [other, dealt] : [dealt, other];
    const from = wallet.get(b.sell_currency);
    if (!from || sell > from.available) {
      return fxErr(400, "insufficient_funds", "insufficient_funds", "conversion");
    }
    from.available -= sell;
    const to = wallet.get(b.buy_currency) ?? { available: 0, reserved: 0 };
    to.available += buy;
    wallet.set(b.buy_currency, to);
    const ms = now();
    const day = new Date(ms).toISOString().slice(0, 10);
    const at = sec(ms);
    const conversion = {
      buy_amount: buy / 100,
      buy_currency: b.buy_currency,
      client_rate: rate.micro / 1_000_000,
      conversion_date: day,
      conversion_id: randomUUID(),
      created_at: at,
      currency_pair: rate.pair,
      dealt_currency: dealtCcy,
      ...(b.quote_id === undefined ? {} : { quote_id: b.quote_id }),
      request_id: rid,
      sell_amount: sell / 100,
      sell_currency: b.sell_currency,
      settlement_cutoff_at: at,
      short_reference_id: `C${day.slice(2, 4)}${day.slice(5, 7)}${day.slice(8, 10)}-${randomUUID().replaceAll("-", "").slice(0, 7).toUpperCase()}`,
      status: "SETTLED",
      updated_at: at,
    };
    conversionRequests.add(rid);
    state.conversions.set(conversion.conversion_id, conversion);
    return { status: 201, body: conversion };
  }

  // GET /fx/conversions. Probed 2026-10-30 with our own REST key: {has_more, items}, and request_id is a
  // working filter: asked about a conversion that same key had made about 1h45m earlier, the list returned
  // it on the first request. An earlier note said the list lags; that came from asking the MCP, a different
  // sandbox account, so it proved nothing. NOT probed: how soon after creation a conversion shows up (the
  // real transfers list showed a new transfer in the same second). The mock lists every conversion at once.
  // ASSUMED: the filters other than request_id, page_size 10 to 1000 with the BELOW_MIN_PAGE_SIZE body of the
  // transactions list, and no from_created_at / to_created_at support.
  function listConversions(q: URLSearchParams): Out {
    const pageNum = intParam(q, "page_num", 0, 0, Number.MAX_SAFE_INTEGER);
    if (pageNum === null) return err(400, "invalid_argument", "Invalid page_num", "page_num");
    const rawSize = q.get("page_size");
    if (rawSize !== null && /^-?\d+$/.test(rawSize) && Number(rawSize) < 10) {
      return err(400, "invalid_argument", "BELOW_MIN_PAGE_SIZE");
    }
    const pageSize = intParam(q, "page_size", 100, 10, 1000);
    if (pageSize === null) return err(400, "invalid_argument", "Invalid page_size", "page_size");
    const filters = ["request_id", "buy_currency", "sell_currency", "status"];
    const all = [...state.conversions.values()]
      .reverse()
      .filter((c) => filters.every((k) => !q.has(k) || c[k] === q.get(k)));
    const end = (pageNum + 1) * pageSize;
    return {
      status: 200,
      body: { has_more: all.length > end, items: all.slice(pageNum * pageSize, end) },
    };
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

  // POST /beneficiaries/create. Shape probed 2026-10-30 with our own REST key (a beneficiary made through
  // the MCP lives in a different sandbox account and is invisible here): 201 with the beneficiary echoed
  // WITHOUT company_name, bank_name added from the IBAN, payer_entity_type defaulting to COMPANY, and a new
  // id every time (the same beneficiary twice is two 201s). A bad IBAN is 400 validation_failed with
  // details.errors [{code "083", source "beneficiary.bank_details.iban"}] and no top-level source.
  // Scope is EUR SEPA companies: PERSONAL, other currencies and SWIFT are refused. ASSUMED: those refusals,
  // every other error code and source (field_required / invalid_argument), that only presence is checked
  // for postcode and state (the sandbox wants 5 digits and an ES-xx state for Spain), and that the 083 code
  // also covers a malformed IBAN or one whose country differs from bank_country_code.
  function createBeneficiary(b: Json): Out {
    const ben: Json = b.beneficiary ?? {};
    const bank: Json = ben.bank_details ?? {};
    const addr: Json = ben.address ?? {};
    const errors: { code: string; source: string }[] = [];
    const text = (v: unknown, source: string, min: number, max: number) => {
      if (v === undefined) errors.push({ code: "field_required", source });
      else if (typeof v !== "string" || v.length < min || v.length > max) {
        errors.push({ code: "invalid_argument", source });
      }
    };
    if (ben.entity_type === undefined)
      errors.push({ code: "field_required", source: "beneficiary.entity_type" });
    else if (ben.entity_type !== "COMPANY")
      errors.push({ code: "invalid_argument", source: "beneficiary.entity_type" });
    if (ben.type !== undefined && ben.type !== "BANK_ACCOUNT") {
      errors.push({ code: "invalid_argument", source: "beneficiary.type" });
    }
    text(ben.company_name, "beneficiary.company_name", 1, 100);
    if (bank.account_currency === undefined) {
      errors.push({ code: "field_required", source: "beneficiary.bank_details.account_currency" });
    } else if (bank.account_currency !== "EUR") {
      errors.push({
        code: "invalid_argument",
        source: "beneficiary.bank_details.account_currency",
      });
    }
    text(bank.account_name, "beneficiary.bank_details.account_name", 2, 200);
    if (typeof bank.account_name === "string" && /^\d+$/.test(bank.account_name)) {
      errors.push({ code: "invalid_argument", source: "beneficiary.bank_details.account_name" });
    }
    text(bank.bank_country_code, "beneficiary.bank_details.bank_country_code", 2, 2);
    const countryMismatch =
      typeof bank.bank_country_code === "string" &&
      validIban(bank.iban) &&
      bank.iban.slice(0, 2) !== bank.bank_country_code;
    if (!validIban(bank.iban) || countryMismatch) {
      errors.push({ code: "083", source: "beneficiary.bank_details.iban" });
    }
    text(addr.street_address, "beneficiary.address.street_address", 5, 200);
    text(addr.city, "beneficiary.address.city", 1, 50);
    text(addr.state, "beneficiary.address.state", 1, 50);
    text(addr.postcode, "beneficiary.address.postcode", 1, 20);
    text(addr.country_code, "beneficiary.address.country_code", 2, 2);
    const methods = b.transfer_methods;
    if (methods === undefined) errors.push({ code: "field_required", source: "transfer_methods" });
    else if (
      !Array.isArray(methods) ||
      methods.length === 0 ||
      methods.some((m) => m !== "LOCAL")
    ) {
      errors.push({ code: "invalid_argument", source: "transfer_methods" });
    }
    if (errors.length) return validationFailed(errors);
    const iban: string = bank.iban;
    const bankName = BANK_NAMES[iban.slice(0, 2) + ":" + iban.slice(4, 8)];
    const rec = {
      beneficiary: {
        address: {
          city: addr.city,
          country_code: addr.country_code,
          postcode: addr.postcode,
          state: addr.state,
          street_address: addr.street_address,
        },
        bank_details: {
          account_currency: "EUR",
          account_name: bank.account_name,
          bank_country_code: bank.bank_country_code,
          ...(bankName ? { bank_name: bankName } : {}),
          iban,
        },
        entity_type: "COMPANY",
        type: "BANK_ACCOUNT",
      },
      id: randomUUID(),
      ...(typeof b.nickname === "string" ? { nickname: b.nickname } : {}),
      payer_entity_type: "COMPANY",
      transfer_methods: methods,
    };
    state.beneficiaries.set(rec.id, rec);
    return { status: 201, body: rec };
  }

  // The sandbox moved a new transfer from SCHEDULED to PROCESSING within about a second (probed 2026-10-30:
  // PROCESSING on the next read, updated_at unchanged). The one-second threshold is ASSUMED.
  function advance(rec: TransferRec): Json {
    if (rec.t.status === "SCHEDULED" && now() - rec.createdMs >= 1000) rec.t.status = "PROCESSING";
    return rec.t;
  }

  // POST /transfers/create. Probed 2026-10-30 with our own REST key (EUR to a EUR SEPA beneficiary, LOCAL):
  // 201, status SCHEDULED, funding FUNDED, fee 0, and the wallet is debited at once (available and total
  // both fall by the amount). A reused request_id is 400 duplicate_request_id with the first transfer's id
  // in details. More than the wallet holds is 400 balance_insufficient (source "transfer"), nothing booked.
  // An unknown beneficiary_id is 400 validation_failed with details.errors [{045, beneficiary_id}].
  // Scope is same-currency LOCAL transfers (what the licence fee needs: convert first, then pay). ASSUMED:
  // refusing SWIFT and a differing source_currency, every other validation code and source, that checks run
  // validation first, then reuse, then funds, that a refused request does not use up its request_id, that the
  // exact balance passes, that amounts may be decimal strings as well as numbers, and the payer profile.
  function createTransfer(b: Json): Out {
    const errors: { code: string; source: string }[] = [];
    const bad = (code: string, source: string) => errors.push({ code, source });
    const rid = b.request_id;
    if (rid === undefined || rid === "") bad("field_required", "request_id");
    else if (typeof rid !== "string" || rid.length > 50) bad("invalid_argument", "request_id");
    const ben =
      typeof b.beneficiary_id === "string" ? state.beneficiaries.get(b.beneficiary_id) : undefined;
    if (b.beneficiary_id === undefined) bad("field_required", "beneficiary_id");
    else if (!ben) bad("045", "beneficiary_id");
    const benCcy = ben?.beneficiary.bank_details.account_currency;
    if (b.transfer_currency === undefined) bad("field_required", "transfer_currency");
    else if (!isCcy(b.transfer_currency) || (ben && b.transfer_currency !== benCcy)) {
      bad("invalid_argument", "transfer_currency");
    }
    if (b.source_currency === undefined) bad("field_required", "source_currency");
    else if (!isCcy(b.source_currency) || b.source_currency !== b.transfer_currency) {
      bad("invalid_argument", "source_currency");
    }
    const hasTransfer = b.transfer_amount !== undefined;
    const hasSource = b.source_amount !== undefined;
    let cents: number | null = null;
    if (hasTransfer === hasSource)
      bad(hasTransfer ? "invalid_argument" : "field_required", "transfer_amount");
    else {
      const field = hasTransfer ? "transfer_amount" : "source_amount";
      cents = toCents(b[field], 1, true);
      if (cents === null) bad("invalid_argument", field);
    }
    if (b.transfer_method === undefined) bad("field_required", "transfer_method");
    else if (b.transfer_method !== "LOCAL") bad("invalid_argument", "transfer_method");
    if (b.reason === undefined) bad("field_required", "reason");
    else if (!TRANSFER_REASONS.includes(b.reason)) bad("invalid_argument", "reason");
    if (b.reference === undefined) bad("field_required", "reference");
    else if (
      typeof b.reference !== "string" ||
      b.reference.length < 1 ||
      b.reference.length > 140
    ) {
      bad("invalid_argument", "reference");
    }
    if (errors.length || !ben || cents === null) return validationFailed(errors);

    const used = transferRequests.get(rid);
    if (used !== undefined) {
      const message = `The request ID ${rid} has been used for a transfer with the transfer ID ${used} before. Please use a different requestID if you wish to create a separate transfer.`;
      return {
        status: 400,
        body: {
          code: "duplicate_request_id",
          details: { id: used, request_id: rid },
          message,
          source: "request_id",
        },
      };
    }
    const ccy: string = b.transfer_currency;
    const wal = wallet.get(ccy);
    if (!wal || cents > wal.available) {
      return {
        status: 400,
        body: {
          code: "balance_insufficient",
          details: {},
          message:
            "There is insufficient Wallet balance to fund this transfer. Top up your Wallet balance or provide a lower amount.",
          source: "transfer",
        },
      };
    }
    wal.available -= cents;
    const ms = now();
    const day = new Date(ms).toISOString().slice(0, 10);
    const at = sec(ms);
    const amount = cents / 100;
    const transfer: Json = {
      amount_beneficiary_receives: amount,
      amount_payer_pays: amount,
      beneficiary: ben.beneficiary,
      beneficiary_id: b.beneficiary_id,
      created_at: at,
      fee_amount: 0,
      fee_currency: ccy,
      fee_paid_by: "PAYER",
      funding: { status: "FUNDED" },
      id: randomUUID(),
      payer: TRANSFER_PAYER,
      reason: b.reason,
      reference: b.reference,
      remarks: "",
      request_id: rid,
      short_reference_id: `P${day.slice(2, 4)}${day.slice(5, 7)}${day.slice(8, 10)}-${randomUUID().replaceAll("-", "").slice(0, 7).toUpperCase()}`,
      source_amount: amount,
      source_currency: ccy,
      status: "SCHEDULED",
      swift_charge_option: "SHARED",
      transfer_amount: amount,
      transfer_currency: ccy,
      transfer_date: day,
      transfer_method: "LOCAL",
      updated_at: at,
    };
    state.transfers.set(transfer.id, { t: transfer, createdMs: ms, cents });
    transferRequests.set(rid, transfer.id);
    return { status: 201, body: transfer };
  }

  // GET /transfers. Probed 2026-10-30: the filter by request_id found a transfer created in the same
  // second (so this is the after-timeout lookup, and it is immediate), and the envelope is {items} only,
  // with no has_more. ASSUMED: newest first, the other filters (the documented ones: status, beneficiary_id,
  // transfer_currency, short_reference_id), and that the cursor paging (page, page_size) is not needed:
  // every match is returned.
  function listTransfers(q: URLSearchParams): Out {
    const filters = [
      "request_id",
      "status",
      "beneficiary_id",
      "transfer_currency",
      "short_reference_id",
    ];
    const items = [...state.transfers.values()]
      .reverse()
      .map(advance)
      .filter((tr) => filters.every((k) => !q.has(k) || tr[k] === q.get(k)));
    return { status: 200, body: { items } };
  }

  // POST /simulation/transfers/{id}/transition. Probed 2026-10-30 with our REST key: SENT then PAID work in
  // that order and the wallet does not move after the create; a transition the transfer cannot make is
  // HTTP 500 {code "operation_failed", message "Request could not be processed"}, not a 400 (seen for
  // repeating PROCESSING and for FAILED from PROCESSING); CANCELLED from PROCESSING answers with status
  // FAILED (failure_reason "simulation", failure_type "PAYMENT_RECALLED"), then the transfer reads back as
  // CANCELLED with a failure block, and the amount returns to the wallet. ASSUMED: PROCESSING from SCHEDULED
  // is allowed (the docs' order), every other pair is a 500, the 400 and 404 bodies, that a transfer cannot
  // be cancelled from SCHEDULED or SENT, and that the answer is the transfer's own shape (the sandbox's
  // answer used an older field order and added a swift_code to the beneficiary).
  function transition(id: string, b: Json): Out {
    const rec = state.transfers.get(id);
    if (!rec) return err(404, "resource_not_found", "Transfer not found");
    const next = b.next_status;
    if (
      typeof next !== "string" ||
      !["PROCESSING", "SENT", "PAID", "FAILED", "CANCELLED", "OVERDUE"].includes(next)
    ) {
      return err(400, "invalid_argument", "Invalid next_status", "next_status");
    }
    const tr = advance(rec);
    const touch = () => {
      tr.updated_at = sec(now());
    };
    if (next === "PROCESSING" && tr.status === "SCHEDULED") {
      tr.status = "PROCESSING";
      touch();
      return { status: 200, body: tr };
    }
    if (
      (next === "SENT" && tr.status === "PROCESSING") ||
      (next === "PAID" && tr.status === "SENT")
    ) {
      tr.status = next;
      tr.dispatch_date = new Date(now()).toISOString().slice(0, 10);
      touch();
      return { status: 200, body: tr };
    }
    if (next === "CANCELLED" && tr.status === "PROCESSING") {
      const wal = wallet.get(tr.transfer_currency);
      if (wal) wal.available += rec.cents;
      tr.status = "CANCELLED";
      tr.failure = { details: { type: "PAYMENT_RECALLED" }, message: "simulation" };
      touch();
      const answer: Json = {
        ...tr,
        status: "FAILED",
        failure_reason: "simulation",
        failure_type: "PAYMENT_RECALLED",
      };
      Reflect.deleteProperty(answer, "failure");
      return { status: 200, body: answer };
    }
    return {
      status: 500,
      body: { code: "operation_failed", message: "Request could not be processed" },
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
    if (method === "POST" && path === "/api/v1/fx/conversions/create") return createConversion(b);
    if (method === "GET" && path === "/api/v1/fx/conversions") return listConversions(query);
    const conversion = /^\/api\/v1\/fx\/conversions\/([^/]+)$/.exec(path);
    if (method === "GET" && conversion) {
      const found = state.conversions.get(conversion[1] ?? "");
      // The 404 code is ASSUMED: only the success of GET by id was probed.
      return found
        ? { status: 200, body: found }
        : fxErr(404, "resource_not_found", "Conversion not found", "conversion_id");
    }
    if (method === "POST" && path === "/api/v1/beneficiaries/create") return createBeneficiary(b);
    const bene = /^\/api\/v1\/beneficiaries\/([^/]+)$/.exec(path);
    if (method === "GET" && bene) {
      // Probed once, with an id from another sandbox account: an unknown id is 200 with NO body.
      const found = state.beneficiaries.get(bene[1] ?? "");
      return found ? { status: 200, body: found } : { status: 200, body: undefined };
    }
    if (method === "POST" && path === "/api/v1/transfers/create") return createTransfer(b);
    if (method === "GET" && path === "/api/v1/transfers") return listTransfers(query);
    const sim = /^\/api\/v1\/simulation\/transfers\/([^/]+)\/transition$/.exec(path);
    if (method === "POST" && sim) return transition(sim[1] ?? "", b);
    const transfer = /^\/api\/v1\/transfers\/([^/]+)$/.exec(path);
    if (method === "GET" && transfer) {
      const found = state.transfers.get(transfer[1] ?? "");
      // The 404 body is ASSUMED: an unknown transfer id was not probed.
      return found
        ? { status: 200, body: advance(found) }
        : err(404, "resource_not_found", "Transfer not found");
    }
    return err(404, "resource_not_found", `No route for ${method} ${path}`);
  }

  const send = (res: ServerResponse, out: Out) => {
    if (res.destroyed) return;
    if (out.body === undefined) {
      res.writeHead(out.status).end();
      return;
    }
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
