import { describe, expect, it, vi } from "vitest";
import type { Payee } from "@warrant/contracts";
import { AirwallexClient } from "./index.js";
import { AirwallexCards, cardControls, controlsDiffer, purchaseResult, redact } from "./card.js";
import type { CardWarrant } from "./card.js";

const seat: Payee = {
  payeeId: "pay_seat",
  displayName: "Design tool seat",
  rail: "airwallex_card",
  routingRef: "merchant_seat",
  currency: "USD",
  merchantCategoryCode: "5734",
};
const warrant: CardWarrant = {
  perPaymentCap: { currency: "USD", cents: 1500 },
  totalBudget: { currency: "USD", cents: 5000 },
  expiresAt: "2026-11-20T00:00:00Z",
  payees: [seat],
};
const buy = (cents: number, key = "seat-1") => ({
  rail: "airwallex_card" as const,
  reservationId: "res_1",
  idempotencyKey: key,
  amount: { currency: "USD" as const, cents },
  routingRef: "merchant_seat",
});

/** A fetch that logs in, then lets `answer` reply to everything else; records each call. */
function fake(answer: (method: string, path: string, body: unknown) => Promise<Response>) {
  const calls: { method: string; path: string; body: unknown }[] = [];
  const fetch = ((url: string, init: RequestInit) => {
    const u = new URL(url);
    if (u.pathname.endsWith("/authentication/login")) {
      return Promise.resolve(new Response(JSON.stringify({ token: "t" }), { status: 201 }));
    }
    const body = init.body ? JSON.parse(String(init.body)) : undefined;
    calls.push({ method: init.method ?? "GET", path: u.pathname + u.search, body });
    return answer(init.method ?? "GET", u.pathname, body);
  }) as typeof globalThis.fetch;
  const client = new AirwallexClient({
    baseUrl: "http://awx.test",
    clientId: "c",
    apiKey: "k",
    fetch,
    timeoutMs: 20,
  });
  return { client, calls };
}

const json = (status: number, body: unknown) =>
  Promise.resolve(new Response(JSON.stringify(body), { status }));

/** Answers enough for issue() to adopt one ACTIVE card whose controls already match. */
function cardServer(simulate: (body: unknown) => Promise<Response>) {
  return fake((method, path, body) => {
    if (path === "/api/v1/issuing/cards") return json(200, { items: [{ card_id: "c1" }] });
    if (path === "/api/v1/issuing/cards/c1") {
      return json(200, {
        card_id: "c1",
        card_status: "ACTIVE",
        authorization_controls: cardControls(warrant),
      });
    }
    if (path === "/api/v1/simulation/issuing/create") return simulate(body);
    if (path === "/api/v1/issuing/cards/c1/update") return json(400, { code: "nope" });
    return json(404, { code: "not_found" });
  });
}

describe("airwallex card: controls mirror the warrant", () => {
  it("cap -> PER_TRANSACTION, budget -> ALL_TIME, expiry -> active_to, MCCs and currency", () => {
    expect(cardControls(warrant)).toEqual({
      active_to: "2026-11-20T00:00:00Z",
      allowed_currencies: ["USD"],
      allowed_merchant_categories: ["5734"],
      allowed_transaction_count: "MULTIPLE",
      transaction_limits: {
        currency: "USD",
        limits: [
          { amount: 15, interval: "PER_TRANSACTION" },
          { amount: 50, interval: "ALL_TIME" },
        ],
      },
    });
  });

  it("a card payee without a code leaves categories open rather than locking the others out", () => {
    const noCode: Payee = { ...seat, payeeId: "pay_other", routingRef: "merchant_other" };
    delete noCode.merchantCategoryCode;
    const open = cardControls({ ...warrant, payees: [seat, noCode] });
    expect(open.allowed_merchant_categories).toEqual([]);
  });

  it("refuses a warrant whose cap and budget are not in one card currency", () => {
    expect(() =>
      cardControls({ ...warrant, totalBudget: { currency: "EUR", cents: 5000 } }),
    ).toThrow();
    expect(() =>
      cardControls({
        ...warrant,
        perPaymentCap: { currency: "USDZ", cents: 1 },
        totalBudget: { currency: "USDZ", cents: 1 },
      }),
    ).toThrow();
  });

  it("names what differs between a card's controls and the warrant's", () => {
    const want = cardControls(warrant);
    expect(controlsDiffer(want, want)).toEqual([]);
    const looser = {
      ...want,
      allowed_merchant_categories: [],
      transaction_limits: { currency: "USD", limits: [{ amount: 500, interval: "ALL_TIME" }] },
    };
    expect(controlsDiffer(looser, want)).toEqual([
      "PER_TRANSACTION limit",
      "ALL_TIME limit",
      "merchant categories",
    ]);
    expect(controlsDiffer(undefined, want)).toContain("limit currency");
  });

  // A card that outlives its warrant is the failure: the expiry must be compared, and compared as
  // a moment in time, because the API answers the same instant in its own spelling.
  it("the same expiry in the API's spellings is no difference, whatever the offset", () => {
    const want = cardControls(warrant); // active_to "2026-11-20T00:00:00Z"
    for (const same of [
      "2026-11-20T00:00:00.000+00:00", // what the sandbox returns (retrieve, 2026-11-03)
      "2026-11-20T00:00:00+0000",
      "2026-11-20T08:00:00.000+08:00",
    ]) {
      expect(controlsDiffer({ ...want, active_to: same }, want)).toEqual([]);
    }
  });

  it("a later, earlier, missing or unreadable expiry is a difference", () => {
    const want = cardControls(warrant);
    for (const other of ["2026-12-20T00:00:00.000+00:00", "2026-11-19T23:59:59.999+00:00"]) {
      expect(controlsDiffer({ ...want, active_to: other }, want)).toEqual(["expiry"]);
    }
    const without = { ...want };
    delete without.active_to;
    expect(controlsDiffer(without, want)).toEqual(["expiry"]);
    for (const bad of ["tomorrow", "", null, 1795132800000]) {
      expect(controlsDiffer({ ...want, active_to: bad }, want)).toEqual(["expiry"]);
    }
  });
});

describe("airwallex card: purchase answers", () => {
  it("reads the legacy sandbox shape and the documented one", () => {
    expect(purchaseResult({ transaction_id: "t1", status: "PENDING" })).toEqual({
      status: "succeeded",
      railRef: "t1",
      detail: "approved by card (PENDING)",
    });
    expect(
      purchaseResult({ transaction_id: "t2", status: "FAILED", failure_reason: "LIMIT_EXCEEDED" }),
    ).toEqual({ status: "failed", railRef: "t2", detail: "declined by card: LIMIT_EXCEEDED" });
    expect(
      purchaseResult({
        card_transaction_id: "t3",
        process_result: "DECLINED",
        failure_reason: "CARD_INACTIVE",
      }),
    ).toMatchObject({ status: "failed", detail: "declined by card: CARD_INACTIVE" });
    expect(purchaseResult({ card_transaction_id: "t4", process_result: "APPROVED" }).status).toBe(
      "succeeded",
    );
    expect(purchaseResult({ transaction_id: "t5", status: "REVERSED" }).status).toBe("failed");
    expect(purchaseResult({ transaction_id: "t6", status: "SOMETHING_NEW" }).status).toBe(
      "unknown",
    );
    expect(purchaseResult(undefined).status).toBe("unknown");
  });

  it("redacts anything shaped like a card number", () => {
    expect(redact(`declined ${"4".repeat(16)} and ${"5".repeat(19)}`)).toBe(
      "declined [redacted] and [redacted]",
    );
    expect(redact("card 9ac4a67d-0865-4b69-8dc1-d3c3d3a117d2 ok")).toContain("9ac4a67d");
  });

  // An upstream that echoes a number the way it is printed on the card.
  // Made-up digits in each real shape: no real or published test number sits in the repo.
  it.each([
    ["4444 4444 4444 4444", "4-4-4-4, spaces"],
    ["4444-4444-4444-4444", "4-4-4-4, dashes"],
    ["4444 4444-4444 4444", "mixed"],
    ["3333 333333 33333", "4-6-5"],
    ["3333 333333 3333", "4-6-4"],
    ["5555 5555 5555 5555 555", "19 digits"],
  ])("redacts %s (%s)", (pan) => {
    expect(redact(`declined ${pan} by the issuer`)).toBe("declined [redacted] by the issuer");
    expect(redact(`${pan}.`)).toBe("[redacted].");
  });

  it("does not eat the text after a spaced number", () => {
    expect(redact("4444 4444 4444 4444 on 2026-11-03")).toBe("[redacted] on 2026-11-03");
  });

  it("leaves ordinary ids, dates, amounts and hashes alone", () => {
    for (const ok of [
      "res_1 prop_licence_fee scene-card-seat-1",
      "2026-11-03T14:22:05.000+00:00",
      "from 2026-11-01 2026-11-30 inclusive",
      "USD 12.34, EUR 50.00, 5000 cents",
      "9820a87c-e80f-4713-a2c1-12f0a011f76f",
      "0x2314f9bc7aebbafaa150bf413480794df92d40e73431ada76cd3354514fae8f0",
      "3f9a 12b4 77c0 9d21",
      "ref 1234 5678 9012", // 12 digits: not a card
    ]) {
      expect(redact(ok)).toBe(ok);
    }
  });
});

describe("airwallex card: execute, status, freeze", () => {
  it("pays the payee's merchant with its category, single phase, in major units", async () => {
    const { client, calls } = cardServer(() =>
      json(200, { transaction_id: "t1", status: "PENDING" }),
    );
    const cards = new AirwallexCards(client);
    expect((await cards.issue(warrant, { requestId: "r1" })).controls).toBe("mirrored");
    expect(await cards.execute(buy(1200))).toMatchObject({ status: "succeeded", railRef: "t1" });
    expect(calls.find((c) => c.path === "/api/v1/simulation/issuing/create")?.body).toEqual({
      card_id: "c1",
      transaction_amount: 12,
      transaction_currency: "USD",
      merchant_info: "Design tool seat",
      merchant_category_code: "5734",
      single_phase: true,
    });
  });

  it("no card, or a payee that is not a card merchant: failed before any call", async () => {
    const { client, calls } = cardServer(() => json(200, {}));
    const cards = new AirwallexCards(client);
    expect((await cards.execute(buy(100))).detail).toBe("no card issued for this warrant");
    await cards.issue(warrant, { requestId: "r1" });
    const n = calls.length;
    const r = await cards.execute({ ...buy(100), routingRef: "someone_else" });
    expect(r).toEqual({ status: "failed", detail: "payee is not a card merchant on the warrant" });
    expect(calls.length).toBe(n);
  });

  it("a timeout is unknown, and the same key is never sent again (the simulator charges twice)", async () => {
    const hang = () =>
      new Promise<Response>((_ok, no) =>
        setTimeout(() => no(Object.assign(new Error("aborted"), { name: "AbortError" })), 5),
      );
    const { client, calls } = cardServer(hang);
    const cards = new AirwallexCards(client);
    await cards.issue(warrant, { requestId: "r1" });
    expect(await cards.execute(buy(1200))).toEqual({ status: "unknown", detail: "timed out" });
    expect(await cards.execute(buy(1200))).toMatchObject({ status: "unknown" });
    expect(await cards.getStatus("seat-1")).toMatchObject({ status: "unknown" });
    expect(calls.filter((c) => c.path.includes("/simulation/")).length).toBe(1);
  });

  it("a 4xx is failed with the code only; a 5xx is unknown", async () => {
    const { client } = cardServer((b) =>
      (b as { transaction_amount: number }).transaction_amount > 1
        ? json(400, { code: "invalid_argument", message: `card ${"4".repeat(16)} raw text` })
        : json(503, { code: "busy" }),
    );
    const cards = new AirwallexCards(client);
    await cards.issue(warrant, { requestId: "r1" });
    expect(await cards.execute(buy(1200))).toEqual({
      status: "failed",
      detail: "purchase refused: invalid_argument",
    });
    expect((await cards.execute(buy(100, "k2"))).status).toBe("unknown");
  });

  it("getStatus finds the purchase by its key; an unknown key is failed", async () => {
    const { client } = fake((_m, path) => {
      if (path === "/api/v1/issuing/cards") return json(200, { items: [{ card_id: "c1" }] });
      if (path === "/api/v1/issuing/cards/c1")
        return json(200, {
          card_id: "c1",
          card_status: "ACTIVE",
          authorization_controls: cardControls(warrant),
        });
      if (path === "/api/v1/simulation/issuing/create")
        return json(200, { transaction_id: "t1", status: "PENDING" });
      if (path === "/api/v1/issuing/transactions")
        return json(200, { has_more: false, items: [{ transaction_id: "t1", status: "CLEARED" }] });
      return json(404, {});
    });
    const cards = new AirwallexCards(client);
    await cards.issue(warrant, { requestId: "r1" });
    await cards.execute(buy(1200));
    expect(await cards.getStatus("seat-1")).toEqual({
      status: "succeeded",
      railRef: "t1",
      detail: "approved by card (CLEARED)",
    });
    expect((await cards.getStatus("never-sent")).status).toBe("failed");
  });

  it("freezeAll sets each card INACTIVE, and throws naming any it could not freeze", async () => {
    let ok = true;
    const { client, calls } = fake((_m, path) => {
      if (path === "/api/v1/issuing/cards") return json(200, { items: [] });
      if (path === "/api/v1/issuing/cardholders") return json(200, { items: [] });
      if (path === "/api/v1/issuing/cardholders/create") return json(201, { cardholder_id: "h1" });
      if (path === "/api/v1/issuing/cards/create")
        return json(201, { card_id: "c9", card_status: "ACTIVE" });
      if (path === "/api/v1/issuing/cards/c9/update")
        return ok ? json(200, { card_id: "c9", card_status: "INACTIVE" }) : json(500, {});
      return json(404, {});
    });
    const cards = new AirwallexCards(client);
    expect(await cards.issue(warrant, { requestId: "r1" })).toEqual({
      cardId: "c9",
      source: "created",
      controls: "mirrored",
    });
    const create = calls.find((c) => c.path === "/api/v1/issuing/cards/create")?.body;
    expect(create).toMatchObject({
      request_id: "r1",
      cardholder_id: "h1",
      form_factor: "VIRTUAL",
      authorization_controls: cardControls(warrant),
    });
    expect(await cards.freezeAll()).toEqual({ frozenCardIds: ["c9"] });
    expect(calls.at(-1)?.body).toEqual({ card_status: "INACTIVE" });
    ok = false;
    await expect(cards.freezeAll()).rejects.toThrow(/could not freeze c9/);
  });

  // The card number never leaves the adapter: the stub echoes a card-number-shaped value in every
  // answer, in both the paid and the failing run of issue, purchase and freezeAll.
  it("a card number echoed by Airwallex never reaches a result, a log line or an error", async () => {
    const pan = "4".repeat(16);
    const echo = { card_number: pan, message: `card ${pan}`, code: `bad ${pan}` };
    let failing = false;
    let refuseCreate = false;
    let cardId = "c1";
    const { client, calls } = fake((_m, path) => {
      if (path === "/api/v1/issuing/cards") return json(200, { items: [], ...echo });
      if (path === "/api/v1/issuing/cardholders") return json(200, { items: [], ...echo });
      if (path === "/api/v1/issuing/cardholders/create")
        return json(201, { cardholder_id: "h1", ...echo });
      if (path === "/api/v1/issuing/cards/create")
        return refuseCreate
          ? json(400, echo)
          : json(201, { card_id: cardId, card_status: "ACTIVE", ...echo });
      if (path === "/api/v1/simulation/issuing/create")
        return failing
          ? json(400, echo)
          : json(200, { transaction_id: "t1", status: "PENDING", ...echo });
      if (path === `/api/v1/issuing/cards/${cardId}/update`)
        return failing
          ? json(500, echo)
          : json(200, { card_id: cardId, card_status: "INACTIVE", ...echo });
      return json(404, echo);
    });
    const logs: string[] = [];
    const spies = (["log", "info", "warn", "error"] as const).map((k) =>
      vi.spyOn(console, k).mockImplementation(() => undefined),
    );
    const seen: string[] = [];
    const attempt = async (run: () => Promise<unknown>) => {
      try {
        seen.push(JSON.stringify(await run()));
      } catch (e) {
        seen.push(String(e), String((e as Error).cause ?? ""));
      }
    };
    try {
      const cards = new AirwallexCards(client, { log: (l) => logs.push(l) });
      await attempt(() => cards.issue(warrant, { requestId: "r1" }));
      await attempt(() => cards.execute(buy(1200)));
      await attempt(() => cards.freezeAll());
      failing = true;
      await attempt(() => cards.execute(buy(1200, "seat-2")));
      await attempt(() => cards.freezeAll());
      refuseCreate = true;
      await attempt(() => new AirwallexCards(client).issue(warrant, { requestId: "r2" }));
      // A card whose own id is shaped like a number reaches the log line and the freeze error.
      refuseCreate = false;
      cardId = pan;
      const odd = new AirwallexCards(client, { log: (l) => logs.push(l) });
      await odd.issue(warrant, { requestId: "r3" }); // returns its own id by design: not checked
      await attempt(() => odd.freezeAll());
      const console_ = spies.flatMap((s) => s.mock.calls.map((c) => c.join(" ")));

      // The echo reached the adapter's own text (so a leak could show), and nothing carries it.
      expect(seen.some((s) => s.includes("[redacted]"))).toBe(true);
      expect(calls.some((c) => c.path.includes("/details"))).toBe(false);
      for (const text of [...seen, ...logs, ...console_]) expect(text).not.toContain(pan);
      expect(logs.length).toBeGreaterThan(0);
    } finally {
      for (const s of spies) s.mockRestore();
    }
  });
});
