// Mock Airwallex: auth, DELEGATE cardholders, virtual cards, simulated single-phase transactions.
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

interface CardRec {
  card: Json;
  limits: { interval: string; cents: number }[];
  currency: string;
  currencies: string[]; // allowed_currencies, empty = all
  categories: string[]; // allowed_merchant_categories, empty = all
  spent: number;
}

export interface AirwallexMock {
  url: string;
  server: Server;
  close(): Promise<void>;
  state: { cardholders: Map<string, Json>; cards: Map<string, CardRec>; transactions: Json[] };
}

const INTERVALS = ["PER_TRANSACTION", "DAILY", "WEEKLY", "MONTHLY", "ALL_TIME"];
const err = (status: number, code: string, message: string, source?: string): Out => ({
  status,
  body: { code, message, ...(source ? { source } : {}) }, // field names ASSUMED from the sandbox error text
});
const stamp = () => new Date().toISOString().replace("Z", "+0000");
const strList = (x: unknown): string[] | null =>
  x === undefined || x === null
    ? []
    : Array.isArray(x) && x.every((s) => typeof s === "string")
      ? x
      : null;
const mask = (n: number) => "************" + String(1000 + (n % 9000));

/** Positive money in cents, parsed from the decimal string. No exponent, max 2 decimals, no float math. */
function toCents(x: unknown): number | null {
  if (typeof x !== "number") return null;
  const m = /^(\d+)(?:\.(\d{1,2}))?$/.exec(String(x));
  if (!m) return null;
  const cents = Number(m[1] + (m[2] ?? "").padEnd(2, "0"));
  return Number.isSafeInteger(cents) && cents > 0 ? cents : null;
}

export async function startAirwallexMock(port = 0): Promise<AirwallexMock> {
  const state: AirwallexMock["state"] = {
    cardholders: new Map(),
    cards: new Map(),
    transactions: [],
  };
  const tokens = new Set<string>();
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
    // Declines are 200 + FAILED, like the sandbox LIMIT_EXCEEDED. Check order is ASSUMED:
    // currency, then merchant category, then limits.
    let failure: string | null =
      rec.currencies.length && !rec.currencies.includes(ccy) ? "CURRENCY_NOT_ALLOWED" : null;
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
    if (!failure) rec.spent += cents;
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

  function route(method: string, path: string, headers: IncomingHttpHeaders, raw: string): Out {
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
    const path = new URL(req.url ?? "/", "http://mock").pathname;
    send(res, route(req.method ?? "GET", path, req.headers, raw));
  });

  await new Promise<void>((resolve) => server.listen(port, "127.0.0.1", resolve));
  const addr = server.address() as { port: number };
  return {
    url: `http://127.0.0.1:${addr.port}`,
    server,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
    state,
  };
}
