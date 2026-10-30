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

  it("replays the same request_id and body, rejects the same id with a different body", async () => {
    const body = cardBody(await makeHolder());
    const first = await call("/api/v1/issuing/cards/create", { body });
    const again = await call("/api/v1/issuing/cards/create", { body });
    expect(again.json.card_id).toBe(first.json.card_id);
    expect(mock.state.cards.size).toBe(1);

    const changed = {
      ...body,
      authorization_controls: {
        ...body.authorization_controls,
        transaction_limits: {
          currency: "USD",
          limits: [{ amount: 20, interval: "PER_TRANSACTION" }],
        },
      },
    };
    const clash = await call("/api/v1/issuing/cards/create", { body: changed });
    expect(clash.status).toBe(400);
    expect(clash.json).toMatchObject({ code: "invalid_argument", source: "request_id" });
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

  it("timeout-after does the work, then holds the response past the client timeout", async () => {
    const holder = await makeHolder();
    mock.fault({ kind: "timeout-after", ms: 400, method: "POST", path: CREATE });
    await expect(
      call(CREATE, { body: cardBody(holder), signal: AbortSignal.timeout(50) }),
    ).rejects.toMatchObject({ name: "TimeoutError" });
    // The caller cannot tell: the card exists. Status must be checked by request_id, never retried blind.
    expect(mock.state.cards.size).toBe(1);
  });

  it("duplicate runs the request twice server-side and still yields one card", async () => {
    const body = cardBody(await makeHolder());
    mock.fault({ kind: "duplicate", method: "POST", path: CREATE });
    const first = await call(CREATE, { body });
    const second = await call(CREATE, { body });
    expect(first.json.card_id).toBe(second.json.card_id);
    expect(mock.state.cards.size).toBe(1);
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
