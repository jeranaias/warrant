// Mock Airwallex: auth, DELEGATE cardholders, virtual cards (freeze), simulated single-phase
// transactions, a transactions list, and an opt-in wallet with INSUFFICIENT_FUNDS declines.
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
}

export interface AirwallexMock {
  url: string;
  server: Server;
  close(): Promise<void>;
  fault(f: Fault): void;
  state: { cardholders: Map<string, Json>; cards: Map<string, CardRec>; transactions: Json[] };
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

export async function startAirwallexMock({
  port = 0,
  balances = {},
}: AirwallexOptions = {}): Promise<AirwallexMock> {
  const state: AirwallexMock["state"] = {
    cardholders: new Map(),
    cards: new Map(),
    transactions: [],
  };
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
  const requestIds = new Map<string, { raw: string; card: Json }>();

  function createCard(b: Json, raw: string): Out {
    const prior = requestIds.get(b.request_id);
    // The replay compares the raw request body, so the same fields in a different key order count as
    // a different body. Same id + same body replays the card: ASSUMED, the probe only changed the body.
    if (prior) {
      return prior.raw === raw
        ? { status: 201, body: prior.card }
        : err(
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
    requestIds.set(b.request_id, { raw, card });
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

  // Legacy list. Confirmed against the sandbox on 2026-10-30: the body is {has_more, items}, and a
  // page_size below 10 is 400 BELOW_MIN_PAGE_SIZE with an empty source. page_num from 0 is from the
  // docs. Newest first, default page_size 10 and max 100 are ASSUMED.
  // The mock lists every simulated transaction, pending and declined included. The real legacy list
  // returned NOTHING for pending or declined transactions on 2026-10-30 (no card_id, from_created_at or
  // other filter changed that); they may only show once settled. So do not rely on this list for
  // pending state: use the simulate response instead.
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
    if (method === "POST" && path === "/api/v1/issuing/cards/create") return createCard(b, raw);
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
