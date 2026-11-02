import { afterEach, describe, expect, it } from "vitest";
import { startAirwallexMock } from "@warrant/mocks/airwallex";
import { AirwallexCards, AirwallexClient } from "@warrant/rails";
import { cardMode, cardScene, cardWorld } from "./card.js";
import { sandboxAirwallexClient } from "./earnings.js";
import { createEngine } from "./server.js";
import { CARD_WARRANT_ID, makeWorld } from "./world.js";

const AT = new Date("2026-11-02T12:00:00Z");
/** 13 to 19 digits in a row: anything that could be a card number. */
const PAN = /\d{13,19}/;

describe("card scene (Kit 2 card on the Airwallex mock)", () => {
  it("pays the seat, control blocks over-cap, the card declines it around control and when frozen", async () => {
    const lines: string[] = [];
    const cw = await cardWorld("mock", AT, (l) => lines.push(l));
    try {
      const steps = await cardScene(() => AT, cw);
      expect(steps.map((s) => [s.step, s.outcome.replace(/ in \d+ ms/, "")])).toEqual([
        ["card ready", "created card, controls mirrored"],
        [
          "treasury buys the design tool seat",
          "control approved; card succeeded (approved by card (PENDING))",
        ],
        [
          "USD 40.00 purchase, through control",
          "blocked by rules (per_payment_cap); card never asked",
        ],
        ["the same purchase straight to the card", "failed (declined by card: LIMIT_EXCEEDED)"],
        ["STOP", "1 card(s) frozen"],
        ["seat purchase after STOP, through control", "blocked by rules (warrant_active)"],
        ["the same purchase straight to the card", "failed (declined by card: CARD_INACTIVE)"],
      ]);
      expect(steps.filter((s) => s.moneyMoved)).toHaveLength(1);

      // PAN and CVV never leave the adapter: not in results, steps, logs or the ledger.
      const ledger = (await cw.cards.getStatus("scene-card-seat-1")) as unknown;
      const everything = JSON.stringify({ steps, lines, ledger, card: cw.card });
      expect(everything).not.toMatch(PAN);
      expect(everything).not.toMatch(/cvv|card_number/i);
      expect(lines.length).toBeGreaterThan(3);
    } finally {
      await cw.close();
    }
  });

  it("the card's own controls mirror the signed warrant", async () => {
    const cw = await cardWorld("mock", AT);
    try {
      const c = cw.card.cardId;
      const card = (await cw.client.call("GET", `/api/v1/issuing/cards/${c}`)).body;
      const w = cw.world.warrants.get(CARD_WARRANT_ID);
      expect(card.brand).toBe("VISA");
      expect(card.authorization_controls).toMatchObject({
        allowed_currencies: ["USD"],
        allowed_merchant_categories: ["5734"],
        transaction_limits: {
          currency: "USD",
          limits: [
            { amount: (w?.perPaymentCap.cents ?? 0) / 100, interval: "PER_TRANSACTION" },
            { amount: (w?.totalBudget.cents ?? 0) / 100, interval: "ALL_TIME" },
          ],
        },
      });
    } finally {
      await cw.close();
    }
  });

  it("the engine's STOP freezes the card through the kill switch", async () => {
    const cw = await cardWorld("mock", AT);
    const { app } = createEngine({ scenario: "none", clock: () => AT, world: cw.world });
    const server = app.listen(0, "127.0.0.1");
    await new Promise<void>((ok) => server.once("listening", () => ok()));
    try {
      const a = server.address();
      const port = typeof a === "object" && a ? a.port : 0;
      const r = await fetch(`http://127.0.0.1:${port}/kill`, { method: "POST" });
      const body = (await r.json()) as { event: { frozenCardIds: string[] } };
      expect(body.event.frozenCardIds).toEqual([cw.card.cardId]);
    } finally {
      server.close();
      await cw.close();
    }
  });

  it("adopts an existing ACTIVE card, says when its controls could not be made to match", async () => {
    const awx = await startAirwallexMock();
    try {
      const client = new AirwallexClient({ baseUrl: awx.url, clientId: "m", apiKey: "m" });
      const holder = (
        await client.call("POST", "/api/v1/issuing/cardholders/create", {
          type: "DELEGATE",
          email: "owner@example.test",
        })
      ).body.cardholder_id as string;
      const made = await client.call("POST", "/api/v1/issuing/cards/create", {
        request_id: "owner-card",
        cardholder_id: holder,
        created_by: "Owner",
        form_factor: "VIRTUAL",
        is_personalized: false,
        program: { purpose: "COMMERCIAL" },
        authorization_controls: {
          transaction_limits: { currency: "USD", limits: [{ amount: 500, interval: "ALL_TIME" }] },
        },
      });
      const id = made.body.card_id as string;
      const cards = new AirwallexCards(client);
      const w = makeWorld(AT, { card: cards }).warrants.get(CARD_WARRANT_ID);
      if (!w) throw new Error("no card warrant");
      const listed = await cards.issue(w, { requestId: "x" });
      expect(listed.cardId).toBe(id);
      expect(listed.source).toBe("listed");
      // The mock only lets card_status change, so the update is refused and reported.
      expect(listed.controls).toMatch(/^not mirrored: PER_TRANSACTION limit, ALL_TIME limit/);

      await client.call("POST", `/api/v1/issuing/cards/${id}/update`, { card_status: "INACTIVE" });
      await expect(cards.issue(w, { requestId: "y", cardId: id })).rejects.toThrow(
        /is INACTIVE, not ACTIVE/,
      );
    } finally {
      await awx.close();
    }
  });
});

describe("card scene: sandbox mode", () => {
  const keys = ["AIRWALLEX_BASE_URL", "AIRWALLEX_CLIENT_ID", "AIRWALLEX_API_KEY"] as const;
  const saved = keys.map((k) => process.env[k]);
  afterEach(() => {
    keys.forEach((k, i) => {
      const v = saved[i];
      if (v === undefined) Reflect.deleteProperty(process.env, k);
      else process.env[k] = v;
    });
  });

  it("is chosen by --sandbox, AIRWALLEX_ENV=sandbox or RAILS_MODE=sandbox", () => {
    expect(cardMode([], {})).toBe("mock");
    expect(cardMode(["node", "x", "--sandbox"], {})).toBe("sandbox");
    expect(cardMode([], { AIRWALLEX_ENV: "sandbox" })).toBe("sandbox");
    expect(cardMode([], { RAILS_MODE: "sandbox" })).toBe("sandbox");
  });

  it("names the missing settings instead of calling anything", async () => {
    // Empty values: loadEnv never overrides a set variable, so a local .env cannot fill them in.
    for (const k of keys) process.env[k] = "";
    await expect(cardWorld("sandbox", AT)).rejects.toThrow(
      "sandbox needs AIRWALLEX_BASE_URL, AIRWALLEX_CLIENT_ID, AIRWALLEX_API_KEY in .env",
    );
  });

  it("refuses a production base URL", () => {
    process.env["AIRWALLEX_BASE_URL"] = "https://api.airwallex.com";
    process.env["AIRWALLEX_CLIENT_ID"] = "id";
    process.env["AIRWALLEX_API_KEY"] = "not-a-key";
    expect(() => sandboxAirwallexClient()).toThrow(/sandbox, never production/);
  });
});
