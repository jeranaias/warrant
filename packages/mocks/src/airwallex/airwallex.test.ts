import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { startAirwallexMock } from "./index.js";
import type { AirwallexMock } from "./index.js";

let mock: AirwallexMock;
let token: string;
let seq = 0;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Json = Record<string, any>;

interface CallInit {
  method?: string;
  body?: unknown;
  token?: string | null;
  signal?: AbortSignal;
}

async function call(path: string, init: CallInit = {}) {
  const bearer = init.token === undefined ? token : init.token;
  const res = await fetch(mock.url + path, {
    method: init.method ?? (init.body === undefined ? "GET" : "POST"),
    headers: {
      "content-type": "application/json",
      ...(bearer ? { authorization: `Bearer ${bearer}` } : {}),
    },
    ...(init.body === undefined ? {} : { body: JSON.stringify(init.body) }),
    ...(init.signal ? { signal: init.signal } : {}),
  });
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return { status: res.status, json: (await res.json()) as any };
}

async function login() {
  const res = await fetch(mock.url + "/api/v1/authentication/login", {
    method: "POST",
    headers: { "x-client-id": "test-client", "x-api-key": "test-key" },
  });
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return { status: res.status, json: (await res.json()) as any };
}

const makeHolder = async () =>
  (
    await call("/api/v1/issuing/cardholders/create", {
      body: { email: "a@b.test", type: "DELEGATE" },
    })
  ).json.cardholder_id as string;

type Limit = { amount: number; interval: string };
const cardBody = (
  cardholder_id: string,
  limits: Limit[] = [{ amount: 10, interval: "PER_TRANSACTION" }],
  extra: object = {},
) => ({
  request_id: `req_${++seq}`,
  cardholder_id,
  created_by: "Test Owner",
  form_factor: "VIRTUAL",
  is_personalized: false,
  program: { purpose: "COMMERCIAL" },
  authorization_controls: {
    allowed_transaction_count: "MULTIPLE",
    transaction_limits: { currency: "USD", limits },
    ...extra,
  },
});

async function makeCard(limits?: Limit[], extra?: object) {
  const res = await call("/api/v1/issuing/cards/create", {
    body: cardBody(await makeHolder(), limits, extra),
  });
  return res.json.card_id as string;
}

const pay = (card_id: string, amount: number, extra: object = { single_phase: true }) =>
  call("/api/v1/simulation/issuing/create", {
    body: { card_id, transaction_amount: amount, transaction_currency: "USD", ...extra },
  });

beforeEach(async () => {
  mock = await startAirwallexMock();
  token = (await login()).json.token;
});

afterEach(async () => {
  mock.server.closeAllConnections();
  await mock.close();
});

describe("auth (strict)", () => {
  it("login needs x-client-id and x-api-key and returns a token", async () => {
    const bad = await fetch(mock.url + "/api/v1/authentication/login", { method: "POST" });
    expect(bad.status).toBe(401);
    const ok = await login();
    expect(ok.status).toBe(201);
    expect(typeof ok.json.token).toBe("string");
    expect(ok.json.expires_at).toBeTruthy();
  });

  it("rejects missing and unissued tokens with 401", async () => {
    expect((await call("/api/v1/issuing/cards/x", { token: null })).status).toBe(401);
    expect((await call("/api/v1/issuing/cards/x", { token: "made-up" })).status).toBe(401);
  });
});

describe("cardholders", () => {
  it("creates a DELEGATE and reads it back", async () => {
    const made = await call("/api/v1/issuing/cardholders/create", {
      body: { email: "a@b.test", type: "DELEGATE" },
    });
    expect(made.json).toMatchObject({ email: "a@b.test", status: "READY", type: "DELEGATE" });
    const got = await call(`/api/v1/issuing/cardholders/${made.json.cardholder_id}`);
    expect(got.json).toEqual(made.json);
  });

  it("refuses INDIVIDUAL, a missing email, and unknown ids", async () => {
    const indiv = await call("/api/v1/issuing/cardholders/create", {
      body: { email: "a@b.test", type: "INDIVIDUAL" },
    });
    expect(indiv.status).toBe(400);
    const noEmail = await call("/api/v1/issuing/cardholders/create", {
      body: { type: "DELEGATE" },
    });
    expect(noEmail.status).toBe(400);
    expect((await call("/api/v1/issuing/cardholders/nope")).status).toBe(404);
  });
});

describe("cards", () => {
  it("creates an ACTIVE virtual card and never returns a full number", async () => {
    const id = await makeCard();
    const got = await call(`/api/v1/issuing/cards/${id}`);
    expect(got.status).toBe(200);
    expect(got.json).toMatchObject({
      card_id: id,
      card_status: "ACTIVE",
      form_factor: "VIRTUAL",
      brand: "VISA",
    });
    expect(got.json.card_number).toMatch(/^\*{12}\d{4}$/);
    expect(got.json.all_card_versions).toHaveLength(1);
    expect(JSON.stringify(got.json)).not.toMatch(/\d{13,}/);
  });

  it("refuses unknown cardholders, physical cards and personalized cards", async () => {
    const holder = await makeHolder();
    const post = (patch: object) =>
      call("/api/v1/issuing/cards/create", { body: { ...cardBody(holder), ...patch } });
    expect((await post({ cardholder_id: "nope" })).status).toBe(400);
    expect((await post({ form_factor: "PHYSICAL" })).status).toBe(400);
    expect((await post({ is_personalized: true })).status).toBe(400);
  });

  it("rejects a reused request_id with 400, even with the same body (the sandbox never replays)", async () => {
    const body = cardBody(await makeHolder());
    expect((await call("/api/v1/issuing/cards/create", { body })).status).toBe(201);
    const again = await call("/api/v1/issuing/cards/create", { body });
    expect(again.status).toBe(400);
    expect(again.json).toMatchObject({
      code: "invalid_argument",
      message: "The provided ID is already associated with a previous request",
      source: "request_id",
    });
    const changed = { ...body, created_by: "Someone Else" };
    expect((await call("/api/v1/issuing/cards/create", { body: changed })).status).toBe(400);
    expect(mock.state.cards.size).toBe(1);
  });

  it.each([10.001, 1e21, 1e-7, 0, -5])(
    "rejects limit amount %s (exponent, >2 decimals, non-positive)",
    async (amount) => {
      const res = await call("/api/v1/issuing/cards/create", {
        body: cardBody(await makeHolder(), [{ amount, interval: "PER_TRANSACTION" }]),
      });
      expect(res.status).toBe(400);
      expect(res.json.source).toBe("authorization_controls");
    },
  );

  it("accepts a one-decimal limit and reports it back", async () => {
    const id = await makeCard([{ amount: 10.5, interval: "PER_TRANSACTION" }]);
    const limits = await call(`/api/v1/issuing/cards/${id}/limits`);
    expect(limits.json).toEqual({
      currency: "USD",
      limits: [{ amount: 10.5, interval: "PER_TRANSACTION", remaining: 10.5 }],
    });
  });
});

describe("simulate transactions (single_phase only)", () => {
  it("returns 400 unless single_phase is true (sandbox default is false)", async () => {
    const id = await makeCard();
    for (const extra of [{}, { single_phase: false }]) {
      const res = await pay(id, 5, extra);
      expect(res.status).toBe(400);
      expect(res.json.source).toBe("single_phase");
    }
  });

  it("approves at the cap and declines one cent over with LIMIT_EXCEEDED", async () => {
    const id = await makeCard();
    const ok = await pay(id, 10);
    expect(ok.status).toBe(200);
    expect(ok.json).toMatchObject({
      transaction_amount: -10,
      transaction_currency: "USD",
      status: "PENDING",
    });
    expect(ok.json.masked_card_number).toMatch(/^\*{12}\d{4}$/);

    const over = await pay(id, 10.01);
    expect(over.status).toBe(200);
    expect(over.json).toMatchObject({
      status: "FAILED",
      failure_reason: "LIMIT_EXCEEDED",
      transaction_amount: -10.01,
    });
  });

  it("refuses bad amounts and unsupported currencies", async () => {
    const id = await makeCard();
    expect((await pay(id, 1.005)).status).toBe(400);
    expect((await pay(id, 0)).status).toBe(400);
    const eur = await call("/api/v1/simulation/issuing/create", {
      body: { card_id: id, transaction_amount: 5, transaction_currency: "EUR", single_phase: true },
    });
    expect(eur.status).toBe(400);
  });

  it.each(["DAILY", "WEEKLY", "MONTHLY", "ALL_TIME"])(
    "%s is cumulative with no reset, and declined spends do not count",
    async (interval) => {
      const id = await makeCard([
        { amount: 10, interval: "PER_TRANSACTION" },
        { amount: 15, interval },
      ]);
      expect((await pay(id, 10)).json.status).toBe("PENDING");
      expect((await pay(id, 6)).json.failure_reason).toBe("LIMIT_EXCEEDED");
      expect((await pay(id, 5)).json.status).toBe("PENDING");
      const limits = await call(`/api/v1/issuing/cards/${id}/limits`);
      expect(limits.json.limits.find((l: Limit) => l.interval === interval).remaining).toBe(0);
    },
  );
});

describe("authorization_controls allowlists", () => {
  it("stores both allowlists on the card", async () => {
    const id = await makeCard(undefined, {
      allowed_currencies: ["USD"],
      allowed_merchant_categories: ["5411"],
    });
    const got = await call(`/api/v1/issuing/cards/${id}`);
    expect(got.json.authorization_controls).toMatchObject({
      allowed_currencies: ["USD"],
      allowed_merchant_categories: ["5411"],
    });
  });

  it("declines a currency outside the allowlist with 200 FAILED, not 400", async () => {
    const id = await makeCard(undefined, { allowed_currencies: ["USD"] });
    const eur = await pay(id, 5, { single_phase: true, transaction_currency: "EUR" });
    expect(eur.status).toBe(200);
    expect(eur.json).toMatchObject({ status: "FAILED", failure_reason: "CURRENCY_NOT_ALLOWED" });
    expect((await pay(id, 5)).json.status).toBe("PENDING");
  });

  it("declines a merchant category outside the allowlist, and the decline spends nothing", async () => {
    const id = await makeCard(
      [
        { amount: 10, interval: "PER_TRANSACTION" },
        { amount: 10, interval: "ALL_TIME" },
      ],
      { allowed_merchant_categories: ["5411"] },
    );
    const bad = await pay(id, 10);
    expect(bad.status).toBe(200);
    expect(bad.json).toMatchObject({
      status: "FAILED",
      failure_reason: "MERCHANT_CATEGORY_NOT_ALLOWED",
      merchant: { category_code: "7531" },
    });
    const ok = await pay(id, 10, { single_phase: true, merchant_category_code: "5411" });
    expect(ok.json).toMatchObject({ status: "PENDING", merchant: { category_code: "5411" } });
  });

  it.each([{ allowed_currencies: "USD" }, { allowed_merchant_categories: [5411] }])(
    "refuses malformed allowlist %j",
    async (extra) => {
      const res = await call("/api/v1/issuing/cards/create", {
        body: cardBody(await makeHolder(), undefined, extra),
      });
      expect(res.status).toBe(400);
      expect(res.json.source).toBe("authorization_controls");
    },
  );
});

const CREATE = "/api/v1/issuing/cards/create";
const SIMULATE = "/api/v1/simulation/issuing/create";
const CARDS = "/api/v1/issuing/cards";
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

// What a caller does when it cannot tell whether a create landed: list the cardholder's cards, retrieve
// each candidate by id (the list has no request_id) and compare its request_id.
const findCard = async (cardholder_id: string, request_id: string) => {
  const list = await call(`${CARDS}?cardholder_id=${cardholder_id}`);
  for (const item of list.json.items) {
    const card = await call(`${CARDS}/${item.card_id}`);
    if (card.json.request_id === request_id) return card.json;
  }
  return undefined;
};

describe("fault injection", () => {
  it("5xx fails before doing any work, then recovers", async () => {
    const holder = await makeHolder();
    mock.fault({ kind: "5xx", method: "POST", path: CREATE });
    const failed = await call(CREATE, { body: cardBody(holder) });
    expect(failed.status).toBe(503);
    expect(mock.state.cards.size).toBe(0);
    const ok = await call(CREATE, { body: cardBody(holder) });
    expect(ok.status).toBe(201);
  });

  it("timeout-after does the work, then holds the response; the caller finds the card by list + retrieve and never resends", async () => {
    const holder = await makeHolder();
    const body = cardBody(holder);
    mock.fault({ kind: "timeout-after", ms: 400, method: "POST", path: CREATE });
    await expect(call(CREATE, { body, signal: AbortSignal.timeout(50) })).rejects.toMatchObject({
      name: "TimeoutError",
    });

    // The caller cannot tell from the abort. It looks the card up instead of resending.
    const found = await findCard(holder, body.request_id);
    expect(found).toMatchObject({
      request_id: body.request_id,
      card_status: "ACTIVE",
      cardholder_id: holder,
    });
    expect(found?.card_id).toMatch(UUID);

    // A blind resend is refused, because Airwallex never replays a card create. One card exists.
    const resend = await call(CREATE, { body });
    expect(resend.status).toBe(400);
    expect(resend.json.source).toBe("request_id");
    expect((await call(`${CARDS}?cardholder_id=${holder}`)).json.items).toHaveLength(1);
  });

  it("duplicate runs the create twice: the caller sees the second run refused, yet one card exists, with a real card_id", async () => {
    const holder = await makeHolder();
    const body = cardBody(holder);
    mock.fault({ kind: "duplicate", method: "POST", path: CREATE });
    const res = await call(CREATE, { body });
    // The second run is the response, and it is the refusal: no card in it.
    expect(res.status).toBe(400);
    expect(res.json).toMatchObject({ code: "invalid_argument", source: "request_id" });
    expect(res.json.card_id).toBeUndefined();

    const list = await call(`${CARDS}?cardholder_id=${holder}`);
    expect(list.json.items).toHaveLength(1);
    const listed: string = list.json.items[0].card_id;
    expect(listed).toMatch(UUID);
    const card = await findCard(holder, body.request_id);
    expect(card?.card_id).toBe(listed);
    expect(card?.request_id).toBe(body.request_id);
    expect((await call(`${CARDS}/${listed}`)).json.card_id).toBe(listed);
  });

  it("duplicate on simulate double-charges, because simulate has no idempotency", async () => {
    const id = await makeCard([
      { amount: 10, interval: "PER_TRANSACTION" },
      { amount: 20, interval: "ALL_TIME" },
    ]);
    mock.fault({ kind: "duplicate", method: "POST", path: SIMULATE });
    expect((await pay(id, 10)).json.status).toBe("PENDING");
    expect(mock.state.transactions).toHaveLength(2);
    const limits = await call(`/api/v1/issuing/cards/${id}/limits`);
    expect(limits.json.limits.find((l: Limit) => l.interval === "ALL_TIME").remaining).toBe(0);
  });

  it("applies a fault only `times` requests, then clears", async () => {
    const holder = await makeHolder();
    mock.fault({ kind: "5xx", method: "POST", path: CREATE, times: 2 });
    const codes = [];
    for (let i = 0; i < 3; i++) codes.push((await call(CREATE, { body: cardBody(holder) })).status);
    expect(codes).toEqual([503, 503, 201]);
  });

  it("matches method plus exact path, not a substring or another method", async () => {
    const holder = await makeHolder();
    mock.fault({ kind: "5xx", method: "GET", path: CREATE });
    mock.fault({ kind: "5xx", method: "POST", path: "/cards/create" });
    expect((await call(CREATE, { body: cardBody(holder) })).status).toBe(201);
  });
});

const UPDATE = (id: string) => `/api/v1/issuing/cards/${id}/update`;
const TXNS = "/api/v1/issuing/transactions";
const BALANCES = "/api/v1/balances/current";

async function restart(opts: Parameters<typeof startAirwallexMock>[0]) {
  mock.server.closeAllConnections();
  await mock.close();
  mock = await startAirwallexMock(opts);
  token = (await login()).json.token;
}

const balanceOf = async (currency: string) =>
  (await call(BALANCES)).json.find((b: { currency: string }) => b.currency === currency);

describe("freeze (card_status update)", () => {
  it("a frozen card declines with CARD_INACTIVE and spends nothing, then works again", async () => {
    const id = await makeCard([
      { amount: 10, interval: "PER_TRANSACTION" },
      { amount: 10, interval: "ALL_TIME" },
    ]);
    const frozen = await call(UPDATE(id), { body: { card_status: "INACTIVE" } });
    expect(frozen.status).toBe(200);
    expect(frozen.json).toMatchObject({ card_id: id, card_status: "INACTIVE" });
    expect(frozen.json.card_number).toMatch(/^\*{12}\d{4}$/);
    expect(frozen.json.all_card_versions).toBeUndefined(); // update returns the create shape
    const seen = await call(`/api/v1/issuing/cards/${id}`);
    expect(seen.json.card_status).toBe("INACTIVE");
    expect(seen.json.all_card_versions[0].card_status).toBe("INACTIVE");

    const declined = await pay(id, 5);
    expect(declined.status).toBe(200);
    expect(declined.json).toMatchObject({
      status: "FAILED",
      failure_reason: "CARD_INACTIVE",
      transaction_type: "CLEARING",
    });

    const thawed = await call(UPDATE(id), { body: { card_status: "ACTIVE" } });
    expect(thawed.json.card_status).toBe("ACTIVE");
    expect((await pay(id, 10)).json.status).toBe("PENDING");
    const limits = await call(`/api/v1/issuing/cards/${id}/limits`);
    expect(limits.json.limits.find((l: Limit) => l.interval === "ALL_TIME").remaining).toBe(0);
  });

  it("freezing an already frozen card is fine", async () => {
    const id = await makeCard();
    expect((await call(UPDATE(id), { body: { card_status: "INACTIVE" } })).status).toBe(200);
    expect((await call(UPDATE(id), { body: { card_status: "INACTIVE" } })).status).toBe(200);
  });

  it.each([
    { card_status: "CLOSED" },
    { card_status: "BOGUS" },
    {},
    { card_status: "INACTIVE", nick_name: "x" },
  ])("refuses the update %j", async (body) => {
    const id = await makeCard();
    const res = await call(UPDATE(id), { body });
    expect(res.status).toBe(400);
    expect(res.json.code).toBe("invalid_argument");
    expect((await call(`/api/v1/issuing/cards/${id}`)).json.card_status).toBe("ACTIVE");
  });

  it("returns 404 for an unknown card", async () => {
    const res = await call(UPDATE("nope"), { body: { card_status: "INACTIVE" } });
    expect(res.status).toBe(404);
    expect(res.json.message).toBe("Card not found");
  });
});

describe("transactions list (legacy page_num / page_size)", () => {
  it("lists one card newest first with {has_more, items}, declines included", async () => {
    const a = await makeCard();
    const b = await makeCard();
    await pay(a, 1);
    await pay(a, 2);
    await pay(b, 3);
    await pay(a, 11); // over the 10.00 cap: FAILED
    const res = await call(`${TXNS}?card_id=${a}`);
    expect(res.status).toBe(200);
    expect(res.json.has_more).toBe(false);
    expect(res.json.items.map((t: Json) => t.transaction_amount)).toEqual([-11, -2, -1]);
    expect(res.json.items[0]).toMatchObject({ status: "FAILED", failure_reason: "LIMIT_EXCEEDED" });
    expect(res.json.items.every((t: Json) => t.card_id === a)).toBe(true);
  });

  it("pages with page_num (from 0) and page_size, default 10, and reports has_more", async () => {
    const id = await makeCard();
    for (let n = 0; n < 12; n++) await pay(id, 1);
    const first = await call(`${TXNS}?card_id=${id}&page_size=10`);
    expect(first.json.items).toHaveLength(10);
    expect(first.json.has_more).toBe(true);
    const dflt = await call(`${TXNS}?card_id=${id}`);
    expect(dflt.json.items).toHaveLength(10);
    const second = await call(`${TXNS}?card_id=${id}&page_size=10&page_num=1`);
    expect(second.json.items).toHaveLength(2);
    expect(second.json.has_more).toBe(false);
    const past = await call(`${TXNS}?card_id=${id}&page_size=10&page_num=5`);
    expect(past.json).toEqual({ has_more: false, items: [] });
  });

  it("without card_id lists every card, and an unknown card_id is an empty list", async () => {
    await pay(await makeCard(), 1);
    await pay(await makeCard(), 1);
    expect((await call(TXNS)).json.items).toHaveLength(2);
    expect((await call(`${TXNS}?card_id=nope`)).json).toEqual({ has_more: false, items: [] });
  });

  // Confirmed against the sandbox 2026-10-30: below 10 is this exact body, with an empty source.
  it.each(["page_size=9", "page_size=1", "page_size=0", "page_size=-1"])(
    "%s is BELOW_MIN_PAGE_SIZE, exactly as the sandbox answers",
    async (qs) => {
      const res = await call(`${TXNS}?${qs}`);
      expect(res.status).toBe(400);
      expect(res.json).toEqual({
        code: "invalid_argument",
        message: "BELOW_MIN_PAGE_SIZE",
        source: "",
      });
    },
  );

  it("accepts the minimum page_size of 10 (inclusive)", async () => {
    expect((await call(`${TXNS}?page_size=10`)).status).toBe(200);
  });

  it.each([
    ["page_size=101", "page_size"],
    ["page_size=1.5", "page_size"],
    ["page_size=1e1", "page_size"],
    ["page_num=-1", "page_num"],
    ["page_num=abc", "page_num"],
  ])("refuses %s with 400 (ASSUMED source)", async (qs, source) => {
    const res = await call(`${TXNS}?${qs}`);
    expect(res.status).toBe(400);
    expect(res.json.source).toBe(source);
  });

  it("every error body carries source, as an empty string when there is none", async () => {
    const holder = await makeHolder();
    const bodies = [
      (await call("/api/v1/issuing/cards/x", { token: null })).json, // 401
      (await call("/api/v1/issuing/cards/nope")).json, // 404 card
      (await call("/api/v1/nowhere")).json, // 404 route
      (await call("/api/v1/issuing/cardholders/create", { body: { type: "DELEGATE" } })).json, // 400 with a source
      (await call(UPDATE("nope"), { body: { card_status: "INACTIVE" } })).json, // 404 card update
      (
        await call("/api/v1/issuing/cards/create", {
          body: { ...cardBody(holder), form_factor: "PHYSICAL" },
        })
      ).json,
    ];
    for (const body of bodies) {
      expect(typeof body.code).toBe("string");
      expect(typeof body.message).toBe("string");
      expect(typeof body.source).toBe("string");
    }
    expect(bodies[0].source).toBe("");
    expect(bodies[1].source).toBe("");
    expect(bodies[3].source).toBe("email");
  });

  it("needs a token", async () => {
    expect((await call(TXNS, { token: null })).status).toBe(401);
    expect((await call(TXNS)).status).toBe(200);
  });
});

describe("balances and INSUFFICIENT_FUNDS (opt-in funds model)", () => {
  it("serves the seeded wallet in the sandbox balance shape", async () => {
    await restart({ balances: { USD: 20, EUR: 5.5 } });
    const res = await call(BALANCES);
    expect(res.status).toBe(200);
    expect(res.json).toHaveLength(2);
    expect(await balanceOf("USD")).toEqual({
      available_amount: 20,
      currency: "USD",
      pending_amount: 0,
      reserved_amount: 0,
      total_amount: 20,
      prepayment_amount: 0,
      account_type: "cash",
    });
    expect((await balanceOf("EUR")).available_amount).toBe(5.5);
  });

  it("needs a token", async () => {
    expect((await call(BALANCES, { token: null })).status).toBe(401);
    expect((await call(BALANCES)).status).toBe(200);
  });

  it("an approval moves available into reserved; pending and total do not move", async () => {
    await restart({ balances: { USD: 20 } });
    await pay(await makeCard(), 5);
    expect(await balanceOf("USD")).toMatchObject({
      available_amount: 15,
      reserved_amount: 5,
      pending_amount: 0,
      total_amount: 20,
    });
  });

  it("is inclusive: the exact balance approves, one cent over declines INSUFFICIENT_FUNDS", async () => {
    await restart({ balances: { USD: 10 } });
    const id = await makeCard([{ amount: 20, interval: "PER_TRANSACTION" }]);
    const over = await pay(id, 10.01);
    expect(over.status).toBe(200);
    expect(over.json).toMatchObject({ status: "FAILED", failure_reason: "INSUFFICIENT_FUNDS" });
    expect(await balanceOf("USD")).toMatchObject({ available_amount: 10, reserved_amount: 0 });
    expect((await pay(id, 10)).json.status).toBe("PENDING");
    expect(await balanceOf("USD")).toMatchObject({ available_amount: 0, reserved_amount: 10 });
    expect((await pay(id, 0.01)).json.failure_reason).toBe("INSUFFICIENT_FUNDS");
  });

  it("other declines never touch the balance, and limits are checked before funds", async () => {
    await restart({ balances: { USD: 100 } });
    const id = await makeCard();
    expect((await pay(id, 11)).json.failure_reason).toBe("LIMIT_EXCEEDED");
    await call(UPDATE(id), { body: { card_status: "INACTIVE" } });
    expect((await pay(id, 5)).json.failure_reason).toBe("CARD_INACTIVE");
    expect(await balanceOf("USD")).toMatchObject({ available_amount: 100, reserved_amount: 0 });

    await restart({ balances: { USD: 5 } });
    const small = await makeCard([{ amount: 6, interval: "PER_TRANSACTION" }]);
    expect((await pay(small, 8)).json.failure_reason).toBe("LIMIT_EXCEEDED"); // ASSUMED order
  });

  it("a zero seed is allowed and declines everything", async () => {
    await restart({ balances: { USD: 0 } });
    expect((await pay(await makeCard(), 0.01)).json.failure_reason).toBe("INSUFFICIENT_FUNDS");
  });

  it("has no wallet and no funds check unless seeded, and only checks seeded currencies", async () => {
    expect((await call(BALANCES)).json).toEqual([]);
    expect((await pay(await makeCard(), 10)).json.status).toBe("PENDING");
    await restart({ balances: { EUR: 5 } });
    expect((await pay(await makeCard(), 8)).json.status).toBe("PENDING"); // USD not seeded: ASSUMED
  });

  it.each([1e21, 10.001, -5])("refuses to start with the bad balance seed %s", async (amount) => {
    await expect(startAirwallexMock({ balances: { USD: amount } })).rejects.toThrow(
      /Invalid balances seed for USD/,
    );
  });
});

const DEPOSIT = "/api/v1/simulation/deposit/create";
const DEPOSITS = "/api/v1/deposits";
const QUOTE = "/api/v1/fx/quotes/create";
const T0 = Date.parse("2026-10-30T20:08:32Z");

describe("simulated deposits", () => {
  it("returns PENDING like the sandbox and raises the wallet", async () => {
    await restart({ balances: { USD: 5 } });
    const res = await call(DEPOSIT, { body: { amount: 10, currency: "USD" } });
    expect(res.status).toBe(201);
    expect(res.json).toMatchObject({ amount: 10, currency: "USD", status: "PENDING" });
    expect(typeof res.json.deposit_id).toBe("string");
    expect(res.json.created_at).toMatch(/^\d{4}-\d\d-\d\dT[\d:.]+\+00:00$/);
    expect(await balanceOf("USD")).toMatchObject({ available_amount: 15, total_amount: 15 });
  });

  it("creates the wallet for a currency nobody seeded, and then funds are checked for it", async () => {
    expect((await call(BALANCES)).json).toEqual([]);
    await call(DEPOSIT, { body: { amount: 5, currency: "USD" } });
    expect(await balanceOf("USD")).toMatchObject({ available_amount: 5 });
    const id = await makeCard([{ amount: 10, interval: "PER_TRANSACTION" }]);
    expect((await pay(id, 6)).json.failure_reason).toBe("INSUFFICIENT_FUNDS");
    expect((await pay(id, 5)).json.status).toBe("PENDING");
  });

  it("lists deposits newest first with the reference and global_account_id round-tripped", async () => {
    const hash = "0x" + "ab".repeat(32);
    await call(DEPOSIT, {
      body: { amount: 1, currency: "USD", reference: hash, global_account_id: "ga_1" },
    });
    await call(DEPOSIT, { body: { amount: 2.5, currency: "EUR" } });
    const res = await call(DEPOSITS);
    expect(res.status).toBe(200);
    expect(res.json.has_more).toBe(false);
    expect(res.json.items.map((d: Json) => d.amount)).toEqual([2.5, 1]);
    expect(res.json.items[1]).toMatchObject({
      currency: "USD",
      reference: hash,
      global_account_id: "ga_1",
      status: "SETTLED",
      type: "BANK_TRANSFER",
    });
    expect(res.json.items[1].created_at).toMatch(/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\+0000$/);
    expect(res.json.items[0]).not.toHaveProperty("reference");
  });

  // Sandbox 2026-10-30: GET /deposits?page_size=10 alone is this exact 400. Both or neither is allowed.
  it("GET /deposits wants page_num and page_size together, and pages when it gets both", async () => {
    for (const n of [1, 2, 3]) await call(DEPOSIT, { body: { amount: n, currency: "USD" } });
    for (const qs of ["page_size=10", "page_num=0"]) {
      const res = await call(`${DEPOSITS}?${qs}`);
      expect(res.status).toBe(400);
      expect(res.json).toEqual({
        code: "invalid_argument",
        message: "both page_num and page_size need to be filled",
        source: "",
      });
    }
    const first = await call(`${DEPOSITS}?page_num=0&page_size=2`);
    expect(first.json.items.map((d: Json) => d.amount)).toEqual([3, 2]);
    expect(first.json.has_more).toBe(true); // {has_more, items} is ASSUMED for deposits
    const second = await call(`${DEPOSITS}?page_num=1&page_size=2`);
    expect(second.json.items.map((d: Json) => d.amount)).toEqual([1]);
    expect(second.json.has_more).toBe(false);
    expect((await call(DEPOSITS)).json.items).toHaveLength(3); // neither param: everything (ASSUMED)
    for (const qs of [
      "page_num=-1&page_size=10",
      "page_num=0&page_size=0",
      "page_num=x&page_size=10",
    ]) {
      expect((await call(`${DEPOSITS}?${qs}`)).status).toBe(400);
    }
  });

  it.each([0, 1e21, 10.001, -5, "10"])("refuses the deposit amount %j", async (amount) => {
    const res = await call(DEPOSIT, { body: { amount, currency: "USD" } });
    expect(res.status).toBe(400);
    expect(res.json).toMatchObject({ code: "invalid_argument", source: "amount" });
    expect((await call(DEPOSITS)).json.items).toEqual([]);
  });

  it.each([{ currency: "usd" }, { currency: 5 }, {}])(
    "refuses the currency in %j",
    async (extra) => {
      const res = await call(DEPOSIT, { body: { amount: 1, ...extra } });
      expect(res.status).toBe(400);
      expect(res.json.source).toBe("currency");
    },
  );

  it("refuses a reference that is not a string, and needs a token", async () => {
    const res = await call(DEPOSIT, { body: { amount: 1, currency: "USD", reference: 5 } });
    expect(res.json.source).toBe("reference");
    expect(
      (await call(DEPOSIT, { token: null, body: { amount: 1, currency: "USD" } })).status,
    ).toBe(401);
    expect((await call(DEPOSITS, { token: null })).status).toBe(401);
  });
});

describe("FX quotes", () => {
  it("quotes in the market-pair direction with the sandbox shape", async () => {
    await restart({ rates: { EURUSD: "1.122579" }, now: () => T0 });
    const res = await call(QUOTE, {
      body: { buy_currency: "EUR", sell_currency: "USD", sell_amount: 10, validity: "MIN_1" },
    });
    expect(res.status).toBe(200); // the sandbox quote create is 200, not 201
    // Sandbox probe 2026-10-30: the same request returned buy_amount 8.91 at client_rate 1.122579.
    expect(res.json).toMatchObject({
      buy_amount: 8.91,
      buy_currency: "EUR",
      sell_amount: 10,
      sell_currency: "USD",
      client_rate: 1.122579,
      currency_pair: "EURUSD",
      dealt_currency: "USD",
      usage: "MULTI_USE",
      validity: "MIN_1",
      conversion_date: "2026-10-30",
      valid_from_at: "2026-10-30T20:08:32+0000",
      valid_to_at: "2026-10-30T20:09:32+0000",
    });
    expect(typeof res.json.quote_id).toBe("string");
  });

  // Real sandbox conversions (2026-10-30, sell USD, buy EUR, pair EURUSD): the derived amount is the
  // exact quotient rounded to the NEAREST cent. Floor and ceil each get at least one of these wrong.
  it.each([
    ["1.124367", 56.23, 50.01],
    ["1.124839", 56.26, 50.02],
    ["1.125308", 56.28, 50.01],
    ["1.125414", 56.29, 50.02],
    ["1.125626", 56.3, 50.02],
  ])(
    "rounds to nearest like the sandbox: rate %s, sell %s USD buys %s EUR",
    async (rate, sell, buy) => {
      await restart({ rates: { EURUSD: rate } });
      const res = await call(QUOTE, {
        body: { buy_currency: "EUR", sell_currency: "USD", sell_amount: sell, validity: "MIN_1" },
      });
      expect(res.json.buy_amount).toBe(buy);
    },
  );

  it("derives the other side in all four directions", async () => {
    await restart({ rates: { EURUSD: "1.122579" } });
    const q = (body: object) =>
      call(QUOTE, { body: { validity: "HR_1", ...body } }).then((r) => r.json);
    // buy is the dealt side: 8.91 EUR costs 8.91 x 1.122579 = 10.0021 USD
    expect(await q({ buy_currency: "EUR", sell_currency: "USD", buy_amount: 8.91 })).toMatchObject({
      sell_amount: 10,
      dealt_currency: "EUR",
    });
    // selling the base currency multiplies: 10 EUR x 1.122579 = 11.22579 USD, nearest cent is 11.23
    expect(await q({ buy_currency: "USD", sell_currency: "EUR", sell_amount: 10 })).toMatchObject({
      buy_amount: 11.23,
      dealt_currency: "EUR",
    });
    // buying the quote currency: 11.23 USD costs 11.23 / 1.122579 = 10.0039 EUR
    expect(await q({ buy_currency: "USD", sell_currency: "EUR", buy_amount: 11.23 })).toMatchObject(
      {
        sell_amount: 10,
        dealt_currency: "USD",
      },
    );
  });

  it.each([
    ["MIN_1", 60],
    ["MIN_15", 900],
    ["MIN_30", 1800],
    ["HR_1", 3600],
    ["HR_4", 14400],
    ["HR_8", 28800],
    ["HR_24", 86400],
  ])("%s lasts %s seconds", async (validity, seconds) => {
    await restart({ rates: { EURUSD: "1.122579" }, now: () => T0 });
    const res = await call(QUOTE, {
      body: { buy_currency: "EUR", sell_currency: "USD", sell_amount: 10, validity },
    });
    const from = Date.parse(res.json.valid_from_at.replace("+0000", "Z"));
    const to = Date.parse(res.json.valid_to_at.replace("+0000", "Z"));
    expect((to - from) / 1000).toBe(seconds);
  });

  it.each([
    [{ validity: "MIN_2" }, "validity"],
    [{ validity: undefined }, "validity"],
    [{ buy_amount: 5 }, "sell_amount"], // both amounts
    [{ sell_amount: undefined }, "sell_amount"], // neither amount
    [{ sell_amount: 10.001 }, "sell_amount"],
    [{ sell_amount: 0 }, "sell_amount"],
    [{ sell_currency: "usd" }, "sell_currency"],
  ])("refuses the quote change %j", async (patch, source) => {
    await restart({ rates: { EURUSD: "1.122579" } });
    const body = {
      buy_currency: "EUR",
      sell_currency: "USD",
      sell_amount: 10,
      validity: "MIN_1",
      ...patch,
    };
    const res = await call(QUOTE, { body });
    expect(res.status).toBe(400);
    expect(res.json).toMatchObject({ code: "invalid_argument", source });
  });

  it("refuses a pair with no seeded rate, and the same currency twice", async () => {
    await restart({ rates: { EURUSD: "1.122579" } });
    const base = { sell_amount: 10, validity: "MIN_1" };
    const gbp = await call(QUOTE, { body: { ...base, buy_currency: "GBP", sell_currency: "USD" } });
    expect(gbp.status).toBe(400);
    expect(gbp.json.code).toBe("unsupported_currency");
    const same = await call(QUOTE, {
      body: { ...base, buy_currency: "USD", sell_currency: "USD" },
    });
    expect(same.json.code).toBe("unsupported_currency");
    const noToken = await call(QUOTE, { token: null, body: base });
    expect(noToken.status).toBe(401);
  });
});

describe("rates and clock options", () => {
  it.each(["abc", "0", "0.000000", "1.1234567", "-1", "", 1.1, null])(
    "refuses to start with the bad rate %j",
    async (rate) => {
      await expect(startAirwallexMock({ rates: { EURUSD: rate as never } })).rejects.toThrow(
        /Invalid rates seed for EURUSD/,
      );
    },
  );

  it.each(["EUR", "EURUSDX", "eurusd", "EUR-USD"])(
    "refuses to start with the rate key %j",
    async (key) => {
      await expect(startAirwallexMock({ rates: { [key]: "1.1" } })).rejects.toThrow(
        /Invalid rates seed/,
      );
    },
  );
});

const CONVERT = "/api/v1/fx/conversions/create";
const CONVERSION = (id: string) => `/api/v1/fx/conversions/${id}`;
const FX = { rates: { EURUSD: "1.122223" }, balances: { USD: 100 } };

// Sell 5 USD for EUR by default; every test overrides what it cares about.
const convert = (patch: object = {}) =>
  call(CONVERT, {
    body: {
      request_id: `conv_${++seq}`,
      buy_currency: "EUR",
      sell_currency: "USD",
      sell_amount: "5",
      ...patch,
    },
  });

const quoteFor = async (validity = "HR_1") =>
  (
    await call(QUOTE, {
      body: { buy_currency: "EUR", sell_currency: "USD", sell_amount: 5, validity },
    })
  ).json;

const CORRELATION = [{ code: "correlation_id", message: expect.any(String) }];

describe("FX conversions", () => {
  it("converts at the market rate, moves exact cents, and answers in the sandbox shape", async () => {
    await restart({ ...FX, now: () => T0 });
    const res = await convert({ request_id: "r1" });
    expect(res.status).toBe(201);
    // Real sandbox answer for the same request: 5.00 USD at 1.122223 bought 4.46 EUR, SETTLED at once.
    expect(res.json).toMatchObject({
      buy_amount: 4.46,
      buy_currency: "EUR",
      sell_amount: 5,
      sell_currency: "USD",
      client_rate: 1.122223,
      currency_pair: "EURUSD",
      dealt_currency: "USD",
      request_id: "r1",
      status: "SETTLED",
      conversion_date: "2026-10-30",
      created_at: "2026-10-30T20:08:32+0000",
      settlement_cutoff_at: "2026-10-30T20:08:32+0000",
      updated_at: "2026-10-30T20:08:32+0000",
    });
    expect(res.json.conversion_id).toEqual(expect.any(String));
    expect(res.json.short_reference_id).toMatch(/^C261030-[A-Z0-9]{7}$/);
    expect(res.json).not.toHaveProperty("quote_id");
    expect(await balanceOf("USD")).toMatchObject({ available_amount: 95, total_amount: 95 });
    expect(await balanceOf("EUR")).toMatchObject({ available_amount: 4.46, total_amount: 4.46 });
  });

  it("reads a conversion back by id, and 404s an unknown one", async () => {
    await restart(FX);
    const made = await convert();
    const got = await call(CONVERSION(made.json.conversion_id));
    expect(got.status).toBe(200);
    expect(got.json).toEqual(made.json);
    const missing = await call(CONVERSION("nope"));
    expect(missing.status).toBe(404); // ASSUMED: the 404 code and body were not probed
    expect(missing.json.code).toBe("resource_not_found");
    expect((await call(CONVERSION("x"), { token: null })).status).toBe(401);
  });

  it("derives the sell side when buy is the dealt side", async () => {
    await restart(FX);
    // 4.46 EUR x 1.122223 = 5.0051 USD, nearest cent 5.01
    const res = await convert({ sell_amount: undefined, buy_amount: "4.46" });
    expect(res.json).toMatchObject({ buy_amount: 4.46, sell_amount: 5.01, dealt_currency: "EUR" });
    expect(await balanceOf("USD")).toMatchObject({ available_amount: 94.99 });
    expect(await balanceOf("EUR")).toMatchObject({ available_amount: 4.46 });
  });

  it("rounds an exact half cent up (the tie direction is ASSUMED)", async () => {
    await restart({ rates: { EURUSD: "2.000000" }, balances: { USD: 10 } });
    // 1.01 USD buys 0.505 EUR at 2.0: the tie goes up to 0.51
    expect((await convert({ sell_amount: "1.01" })).json.buy_amount).toBe(0.51);
  });

  it("a quote locks its rate when the market moves, and can be used again", async () => {
    await restart({ ...FX, now: () => T0 });
    const q = await quoteFor();
    mock.state.rates.set("EURUSD", 1_000_000); // the market moves to 1.000000
    const locked = await convert({ quote_id: q.quote_id });
    // quote_id echoed on the conversion is ASSUMED (the docs say so; not probed)
    expect(locked.json).toMatchObject({
      buy_amount: 4.46,
      client_rate: 1.122223,
      quote_id: q.quote_id,
    });
    expect((await convert({ quote_id: q.quote_id })).status).toBe(201); // MULTI_USE reuse: ASSUMED
    const market = await convert();
    expect(market.json).toMatchObject({ buy_amount: 5, client_rate: 1 });
  });

  it("refuses an expired quote with the sandbox body, valid up to valid_to_at inclusive", async () => {
    let clock = T0;
    await restart({ ...FX, now: () => clock });
    const q = await quoteFor("MIN_1");
    clock = T0 + 60_000; // exactly valid_to_at: still good (inclusive is ASSUMED from the docs)
    expect((await convert({ quote_id: q.quote_id })).status).toBe(201);
    clock = T0 + 60_001;
    const late = await convert({ quote_id: q.quote_id });
    expect(late.status).toBe(400);
    expect(late.json).toEqual({
      code: "expired_quote",
      message: "Quote has expired",
      source: "quoteId",
      details: CORRELATION,
    });
    expect(await balanceOf("USD")).toMatchObject({ available_amount: 95 });
    expect(mock.state.conversions.size).toBe(1);
  });

  it("refuses an unknown quote and a quote for another direction", async () => {
    await restart({ rates: FX.rates, balances: { USD: 100, EUR: 100 } });
    const unknown = await convert({ quote_id: "nope" });
    expect(unknown.status).toBe(400);
    expect(unknown.json).toMatchObject({ code: "invalid_quote_id", source: "quoteId" });
    const q = await quoteFor(); // sell USD, buy EUR
    const reversed = await convert({
      quote_id: q.quote_id,
      sell_currency: "EUR",
      buy_currency: "USD",
    });
    expect(reversed.status).toBe(400);
    expect(reversed.json).toMatchObject({ code: "invalid_argument", source: "quoteId" });
    expect(mock.state.conversions.size).toBe(0);
  });

  it("rejects a repeated request_id, same body or not, with the sandbox body", async () => {
    await restart(FX);
    const first = await convert({ request_id: "dup-1" });
    const again = await convert({ request_id: "dup-1" });
    expect(again.status).toBe(400);
    expect(again.json).toEqual({
      code: "invalid_argument",
      message:
        "request_id 'dup-1' has been used in the past. Please use a different request_id for this request",
      source: "request_id",
      details: CORRELATION,
    });
    expect((await convert({ request_id: "dup-1", sell_amount: "6" })).status).toBe(400);
    expect(await balanceOf("USD")).toMatchObject({ available_amount: 95 }); // moved once
    expect(mock.state.conversions.size).toBe(1);
    expect((await call(CONVERSION(first.json.conversion_id))).json).toEqual(first.json);
  });

  it("does not consume a request_id on a refused conversion (ASSUMED)", async () => {
    await restart({ rates: FX.rates, balances: { USD: 1 } });
    expect((await convert({ request_id: "retry-1" })).json.code).toBe("insufficient_funds");
    await call(DEPOSIT, { body: { amount: 10, currency: "USD" } });
    expect((await convert({ request_id: "retry-1" })).status).toBe(201);
  });

  it("refuses to sell more than is available, inclusive at the exact balance, nothing moves", async () => {
    await restart({ rates: FX.rates, balances: { USD: 5 } });
    const over = await convert({ sell_amount: "5.01" });
    expect(over.status).toBe(400);
    // Real sandbox answer when selling a currency the wallet holds none of (SGD, 2026-10-30).
    expect(over.json).toEqual({
      code: "insufficient_funds",
      message: "insufficient_funds",
      source: "conversion",
      details: CORRELATION,
    });
    expect(await balanceOf("USD")).toMatchObject({ available_amount: 5 });
    expect(await balanceOf("EUR")).toBeUndefined();
    expect(mock.state.conversions.size).toBe(0);
    expect((await convert({ sell_amount: "5" })).status).toBe(201); // exact balance passes (ASSUMED)
    expect(await balanceOf("USD")).toMatchObject({ available_amount: 0 });
  });

  it("conversions spend available funds, not funds a card has reserved", async () => {
    await restart({ rates: FX.rates, balances: { USD: 10 } });
    await pay(await makeCard([{ amount: 10, interval: "PER_TRANSACTION" }]), 5);
    expect((await convert({ sell_amount: "5.01" })).json.code).toBe("insufficient_funds");
    expect((await convert({ sell_amount: "5" })).status).toBe(201);
  });

  it("an unseeded currency is zero for conversions but unlimited for card purchases", async () => {
    await restart({ rates: FX.rates }); // no wallet at all
    expect((await convert()).json.code).toBe("insufficient_funds");
    expect((await pay(await makeCard(), 5)).json.status).toBe("PENDING");
  });

  it("refuses a dealt amount under 1.00 (the limit is ASSUMED to apply to any currency)", async () => {
    await restart(FX);
    const low = await convert({ sell_amount: "0.99" });
    expect(low.status).toBe(400);
    expect(low.json.code).toBe("amount_below_limit");
    expect((await convert({ sell_amount: "1.00" })).status).toBe(201);
  });

  it.each([
    [{ request_id: undefined }, "field_required", "request_id"],
    [{ request_id: "" }, "field_required", "request_id"],
    [{ request_id: "x".repeat(65) }, "invalid_argument", "request_id"],
    [{ buy_currency: undefined }, "field_required", "buy_currency"],
    [{ sell_currency: "usd" }, "invalid_argument", "sell_currency"],
    [{ sell_amount: undefined }, "field_required", "sell_amount"],
    [{ buy_amount: "4" }, "invalid_argument", "sell_amount"],
    [{ sell_amount: "10.001" }, "invalid_argument", "sell_amount"],
    [{ sell_amount: "1e1" }, "invalid_argument", "sell_amount"],
    [{ sell_amount: "-5" }, "invalid_argument", "sell_amount"],
    [{ sell_amount: "abc" }, "invalid_argument", "sell_amount"],
    [{ sell_amount: 0 }, "invalid_argument", "sell_amount"],
    [{ buy_currency: "USD" }, "unsupported_currency", "buy_currency"],
    [{ buy_currency: "GBP" }, "unsupported_currency", "buy_currency"],
  ])("refuses %j with %s on %s, moving nothing", async (patch, code, source) => {
    await restart(FX);
    const res = await convert(patch);
    expect(res.status).toBe(400);
    expect(res.json).toMatchObject({ code, source });
    expect(res.json.details).toEqual(CORRELATION);
    expect(await balanceOf("USD")).toMatchObject({ available_amount: 100 });
    expect(mock.state.conversions.size).toBe(0);
  });

  it("needs a token", async () => {
    await restart(FX);
    const res = await call(CONVERT, { token: null, body: { request_id: "t" } });
    expect(res.status).toBe(401);
    expect((await call(CONVERT, { body: { request_id: "t" } })).status).toBe(400); // route exists
  });
});

describe("cards list (GET /issuing/cards)", () => {
  it("lists a cardholder's cards oldest first in the summary shape, without request_id or controls", async () => {
    const a = await makeHolder();
    const b = await makeHolder();
    const first = await call(CREATE, { body: cardBody(a) });
    await call(CREATE, { body: cardBody(a) });
    await call(CREATE, { body: cardBody(b) });
    const res = await call(`${CARDS}?cardholder_id=${a}`);
    expect(res.status).toBe(200);
    expect(res.json.has_more).toBe(false);
    expect(res.json.items).toHaveLength(2);
    // Shape probed 2026-10-30: the summary fields only, card number masked.
    expect(res.json.items[0]).toEqual({
      brand: "VISA",
      card_id: first.json.card_id,
      card_number: first.json.card_number,
      card_status: "ACTIVE",
      cardholder_id: a,
      created_at: first.json.created_at,
      updated_at: first.json.updated_at,
    });
    expect(res.json.items[0].card_number).toMatch(/^\*{12}\d{4}$/);
    expect(res.json.items[0]).not.toHaveProperty("request_id");
    expect(res.json.items[0]).not.toHaveProperty("authorization_controls");
    expect(res.json.items.every((c: { cardholder_id: string }) => c.cardholder_id === a)).toBe(
      true,
    );
  });

  it("filters by card_status, lists every card without a filter, and an unknown cardholder is empty", async () => {
    const holder = await makeHolder();
    await call(CREATE, { body: cardBody(holder) });
    await call(CREATE, { body: cardBody(await makeHolder()) });
    expect((await call(CARDS)).json.items).toHaveLength(2);
    expect((await call(`${CARDS}?card_status=ACTIVE`)).json.items).toHaveLength(2);
    expect((await call(`${CARDS}?card_status=INACTIVE`)).json.items).toHaveLength(0);
    expect((await call(`${CARDS}?cardholder_id=nobody`)).json).toEqual({
      has_more: false,
      items: [],
    });
  });

  it("pages with page_num from 0 and page_size (default 100, minimum 10)", async () => {
    const holder = await makeHolder();
    const ids: string[] = [];
    for (let n = 0; n < 12; n++)
      ids.push((await call(CREATE, { body: cardBody(holder) })).json.card_id);
    const first = await call(`${CARDS}?cardholder_id=${holder}&page_num=0&page_size=10`);
    expect(first.json.items.map((c: { card_id: string }) => c.card_id)).toEqual(ids.slice(0, 10));
    expect(first.json.has_more).toBe(true);
    const second = await call(`${CARDS}?cardholder_id=${holder}&page_num=1&page_size=10`);
    expect(second.json.items.map((c: { card_id: string }) => c.card_id)).toEqual(ids.slice(10));
    expect(second.json.has_more).toBe(false);
    expect((await call(`${CARDS}?cardholder_id=${holder}`)).json.items).toHaveLength(12);
  });

  // ASSUMED for this endpoint: the 10 minimum and the 200 maximum come from the docs and the MCP tool text.
  it.each([
    ["page_size=9", "BELOW_MIN_PAGE_SIZE"],
    ["page_size=0", "BELOW_MIN_PAGE_SIZE"],
    ["page_size=201", "Invalid page_size"],
    ["page_size=1.5", "Invalid page_size"],
    ["page_num=-1", "Invalid page_num"],
    ["page_num=x", "Invalid page_num"],
  ])("refuses %s with 400 %s", async (qs, message) => {
    const res = await call(`${CARDS}?${qs}`);
    expect(res.status).toBe(400);
    expect(res.json).toMatchObject({ code: "invalid_argument", message });
  });

  it("needs a token", async () => {
    expect((await call(CARDS, { token: null })).status).toBe(401);
    expect((await call(CARDS)).status).toBe(200);
  });
});

const CONVERSIONS = "/api/v1/fx/conversions";
const SEEDED = { rates: { EURUSD: "1.122223" }, balances: { USD: 100, EUR: 100 } };

describe("conversions list (GET /fx/conversions)", () => {
  it("lists newest first as {has_more, items} and finds one conversion by request_id", async () => {
    await restart(SEEDED);
    const made = [];
    for (const id of ["r1", "r2", "r3"]) made.push((await convert({ request_id: id })).json);
    const all = await call(CONVERSIONS);
    expect(all.status).toBe(200);
    expect(all.json.has_more).toBe(false);
    expect(all.json.items.map((c: Json) => c.request_id)).toEqual(["r3", "r2", "r1"]);

    const one = await call(`${CONVERSIONS}?request_id=r2`);
    expect(one.json).toEqual({ has_more: false, items: [made[1]] });
    const none = await call(`${CONVERSIONS}?request_id=never-sent`);
    expect(none.json).toEqual({ has_more: false, items: [] });
  });

  it("filters by buy_currency, sell_currency and status", async () => {
    await restart(SEEDED);
    await convert({ request_id: "a" });
    await convert({ request_id: "b" });
    await convert({ request_id: "c", sell_currency: "EUR", buy_currency: "USD" });
    const count = async (qs: string) => (await call(`${CONVERSIONS}?${qs}`)).json.items.length;
    expect(await count("sell_currency=USD")).toBe(2);
    expect(await count("sell_currency=EUR")).toBe(1);
    expect(await count("buy_currency=EUR")).toBe(2);
    expect(await count("status=SETTLED")).toBe(3);
    expect(await count("status=CANCELLED")).toBe(0);
    expect(await count("sell_currency=USD&buy_currency=USD")).toBe(0);
  });

  it("pages with page_num from 0 and page_size (default 100, minimum 10)", async () => {
    await restart(SEEDED);
    for (let n = 0; n < 12; n++) await convert({ request_id: `p${n}`, sell_amount: "1" });
    const first = await call(`${CONVERSIONS}?page_num=0&page_size=10`);
    expect(first.json.items).toHaveLength(10);
    expect(first.json.has_more).toBe(true);
    expect(first.json.items[0].request_id).toBe("p11");
    const second = await call(`${CONVERSIONS}?page_num=1&page_size=10`);
    expect(second.json.items).toHaveLength(2);
    expect(second.json.has_more).toBe(false);
    expect((await call(CONVERSIONS)).json.items).toHaveLength(12);
  });

  // The 10 minimum is from the MCP tool schema and the sandbox's other lists; the exact body for this
  // endpoint is ASSUMED to match the transactions list.
  it.each(["page_size=9", "page_size=0"])("%s is BELOW_MIN_PAGE_SIZE", async (qs) => {
    await restart(SEEDED);
    const res = await call(`${CONVERSIONS}?${qs}`);
    expect(res.status).toBe(400);
    expect(res.json).toEqual({
      code: "invalid_argument",
      message: "BELOW_MIN_PAGE_SIZE",
      source: "",
    });
  });

  it.each(["page_num=-1", "page_num=x", "page_size=1001", "page_size=1.5"])(
    "refuses %s with 400",
    async (qs) => {
      await restart(SEEDED);
      expect((await call(`${CONVERSIONS}?${qs}`)).status).toBe(400);
    },
  );

  it("needs a token", async () => {
    await restart(SEEDED);
    expect((await call(CONVERSIONS, { token: null })).status).toBe(401);
    expect((await call(CONVERSIONS)).status).toBe(200);
  });

  // After a timeout the caller must not resend: the conversion may exist. It looks the request up by
  // request_id instead, and a resend would be refused anyway (the real API answers a reused request_id with
  // a 400).
  it("after a timed-out create, the caller finds the conversion by request_id and does not resend", async () => {
    await restart(SEEDED);
    mock.fault({ kind: "timeout-after", ms: 400, method: "POST", path: CONVERT });
    await expect(
      call(CONVERT, {
        body: {
          request_id: "timeout-1",
          buy_currency: "EUR",
          sell_currency: "USD",
          sell_amount: "5",
        },
        signal: AbortSignal.timeout(50),
      }),
    ).rejects.toMatchObject({ name: "TimeoutError" });

    const found = await call(`${CONVERSIONS}?request_id=timeout-1`);
    expect(found.json.items).toHaveLength(1);
    expect(found.json.items[0]).toMatchObject({ request_id: "timeout-1", status: "SETTLED" });
    expect(await balanceOf("USD")).toMatchObject({ available_amount: 95 });

    // a blind resend is refused, so the money moved once
    expect((await convert({ request_id: "timeout-1" })).status).toBe(400);
    expect(await balanceOf("USD")).toMatchObject({ available_amount: 95 });
  });
});
