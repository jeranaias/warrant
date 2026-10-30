import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { startAirwallexMock } from "./index.js";
import type { AirwallexMock } from "./index.js";

let mock: AirwallexMock;
let token: string;
let seq = 0;

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
