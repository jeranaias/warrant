import { describe, expect, it } from "vitest";
import {
  AirwallexClient,
  AirwallexTransfers,
  LOOKUP_GRACE_MS,
  cents,
  major,
  transferStatus,
} from "./index.js";

const instruction = {
  rail: "airwallex_transfer" as const,
  reservationId: "res_1",
  idempotencyKey: "fee-1",
  amount: { currency: "EUR" as const, cents: 5000 },
  routingRef: "ben_1",
};

/** A fetch that logs in, then answers `answer` for everything else. */
function fakeFetch(answer: (path: string) => Promise<Response>): typeof fetch {
  return ((url: string) => {
    const path = new URL(url).pathname;
    if (path.endsWith("/authentication/login")) {
      return Promise.resolve(new Response(JSON.stringify({ token: "t" }), { status: 201 }));
    }
    return answer(path);
  }) as typeof fetch;
}

describe("airwallex client: never production", () => {
  const make = (baseUrl: string) =>
    new AirwallexClient({ baseUrl, clientId: "c", apiKey: "not-a-key" });

  // Any Airwallex host but the sandbox API is refused, however the URL is dressed up. The word
  // "sandbox" in a path or a user name is not the sandbox.
  it.each([
    "https://api.airwallex.com",
    "https://api.airwallex.com/",
    "https://API.AIRWALLEX.COM",
    "https://api.airwallex.com.", // a trailing dot is the same host
    "https://api.airwallex.com/sandbox",
    "https://api.airwallex.com/?env=sandbox",
    "https://api.sandbox.airwallex.com@api.airwallex.com", // the host is what follows the @
    "https://airwallex.com",
    "https://pci-api.airwallex.com",
    "https://api.demo.airwallex.com",
  ])("refuses %s", (url) => {
    expect(() => make(url)).toThrow("Airwallex base URL must be the sandbox, never production");
  });

  it("refuses a base URL that is not a URL, without echoing it", () => {
    expect(() => make("api.sandbox.airwallex.com")).toThrow("Airwallex base URL is not a URL");
  });

  it.each([
    "https://api.sandbox.airwallex.com",
    "https://api.sandbox.airwallex.com/",
    "http://127.0.0.1:4010",
    "http://localhost:8080",
    "http://awx.test",
  ])("accepts %s", (url) => {
    expect(() => make(url)).not.toThrow();
  });
});

describe("airwallex adapter: money and status", () => {
  it("converts cents to major units and back with integer math", () => {
    expect(major(5000)).toBe("50.00");
    expect(major(7)).toBe("0.07");
    expect(cents(56.13)).toBe(5613);
    expect(cents("4.5")).toBe(450);
    expect(cents("1e3")).toBeUndefined();
    expect(() => major(1.5)).toThrow();
  });

  it("PAID is done, FAILED and CANCELLED failed, everything else on the way", () => {
    expect(transferStatus({ id: "t1", status: "PAID" }).status).toBe("succeeded");
    expect(transferStatus({ id: "t1", status: "CANCELLED" }).status).toBe("failed");
    expect(transferStatus({ id: "t1", status: "SENT" })).toEqual({
      status: "pending",
      railRef: "t1",
      detail: "SENT",
    });
    expect(transferStatus(undefined).status).toBe("unknown");
  });

  it("a timeout is unknown, never failed: control looks it up before anything else", async () => {
    const hang = () =>
      new Promise<Response>((_ok, no) =>
        setTimeout(() => no(Object.assign(new Error("aborted"), { name: "AbortError" })), 5),
      );
    const rail = new AirwallexTransfers(
      new AirwallexClient({
        baseUrl: "http://awx.test",
        clientId: "c",
        apiKey: "k",
        fetch: fakeFetch(hang),
      }),
      { fundingCurrency: "USD" },
    );
    expect(await rail.execute(instruction)).toEqual({ status: "unknown", detail: "timed out" });
  });

  it("a refused transfer is failed with the code only, never the upstream text", async () => {
    const answer = (path: string) =>
      Promise.resolve(
        path.endsWith("/balances/current")
          ? new Response(JSON.stringify([{ currency: "EUR", available_amount: 100 }]), {
              status: 200,
            })
          : new Response(
              JSON.stringify({ code: "balance_insufficient", message: "Top up your Wallet" }),
              { status: 400 },
            ),
      );
    const rail = new AirwallexTransfers(
      new AirwallexClient({
        baseUrl: "http://awx.test",
        clientId: "c",
        apiKey: "k",
        fetch: fakeFetch(answer),
      }),
      { fundingCurrency: "USD" },
    );
    expect(await rail.execute(instruction)).toEqual({
      status: "failed",
      detail: "transfer refused: balance_insufficient",
    });
  });

  it("a 5xx on transfer create is unknown, not failed: the transfer may exist", async () => {
    // A failed result lets control release the reservation and retry: a second payment.
    const answer = (path: string) =>
      Promise.resolve(
        path.endsWith("/balances/current")
          ? new Response(JSON.stringify([{ currency: "EUR", available_amount: 100000 }]), {
              status: 200,
            })
          : new Response(JSON.stringify({ code: "internal_error" }), { status: 503 }),
      );
    const rail = new AirwallexTransfers(
      new AirwallexClient({
        baseUrl: "http://awx.test",
        clientId: "c",
        apiKey: "k",
        fetch: fakeFetch(answer),
      }),
      { fundingCurrency: "USD" },
    );
    expect(await rail.execute(instruction)).toEqual({
      status: "unknown",
      detail: "transfer service error",
    });
  });
});

describe("airwallex adapter: an unreadable wallet balance", () => {
  // Read as "no euros", it would buy FX and send a payout the wallet may not cover.
  it.each([
    ["a 503", () => new Response("{}", { status: 503 })],
    ["a 400", () => new Response(JSON.stringify({ code: "invalid_argument" }), { status: 400 })],
    [
      "a 200 that is not a list",
      () => new Response(JSON.stringify({ items: [] }), { status: 200 }),
    ],
  ])("%s stops before any conversion or transfer", async (_name, balance) => {
    const calls: string[] = [];
    const answer = (path: string) => {
      calls.push(path);
      return Promise.resolve(
        path.endsWith("/balances/current")
          ? balance()
          : new Response(JSON.stringify({ id: "x", status: "SCHEDULED" }), { status: 201 }),
      );
    };
    const rail = new AirwallexTransfers(
      new AirwallexClient({
        baseUrl: "http://awx.test",
        clientId: "c",
        apiKey: "k",
        fetch: fakeFetch(answer),
      }),
      { fundingCurrency: "USD" },
    );
    expect(await rail.execute(instruction)).toEqual({
      status: "failed",
      detail: "wallet balance could not be read",
    });
    expect(calls).toEqual(["/api/v1/balances/current"]);
  });
});

describe("airwallex adapter: an empty lookup after a doubtful create", () => {
  const T0 = new Date("2026-11-01T12:00:00Z").getTime();

  /** A rail on a clock the test moves; the list is empty and a create is answered `createAnswer`. */
  function railOnClock(
    createAnswer: (path: string) => Promise<Response>,
    fundingCurrency: "USD" | "EUR" = "EUR",
  ) {
    let now = T0;
    const answer = (path: string) => {
      if (path.endsWith("/balances/current")) {
        return Promise.resolve(
          new Response(JSON.stringify([{ currency: "EUR", available_amount: 0 }]), { status: 200 }),
        );
      }
      if (path.endsWith("/transfers")) {
        return Promise.resolve(new Response(JSON.stringify({ items: [] }), { status: 200 }));
      }
      return createAnswer(path);
    };
    const rail = new AirwallexTransfers(
      new AirwallexClient({
        baseUrl: "http://awx.test",
        clientId: "c",
        apiKey: "k",
        fetch: fakeFetch(answer),
      }),
      { fundingCurrency, clock: () => new Date(now) },
    );
    return { rail, at: (ms: number) => void (now = T0 + ms) };
  }

  const serverError = () =>
    Promise.resolve(new Response(JSON.stringify({ code: "internal_error" }), { status: 503 }));

  it("after a 5xx it stays unknown inside the window and settles failed once it has passed", async () => {
    // Too early a failed releases the money while the create may still be in progress.
    const { rail, at } = railOnClock(serverError);
    expect((await rail.execute(instruction)).status).toBe("unknown");
    at(LOOKUP_GRACE_MS - 1);
    expect(await rail.getStatus(instruction.idempotencyKey)).toEqual({
      status: "unknown",
      detail: "not listed yet",
    });
    at(LOOKUP_GRACE_MS);
    expect(await rail.getStatus(instruction.idempotencyKey)).toEqual({
      status: "failed",
      detail: "no transfer with this key",
    });
  });

  it("a key this process never sent (after a restart) starts its window at the first lookup", async () => {
    const { rail, at } = railOnClock(serverError);
    expect((await rail.getStatus("sent-before-restart")).status).toBe("unknown");
    at(LOOKUP_GRACE_MS - 1);
    expect((await rail.getStatus("sent-before-restart")).status).toBe("unknown");
    at(LOOKUP_GRACE_MS);
    expect((await rail.getStatus("sent-before-restart")).status).toBe("failed");
  });

  it("a conversion that times out counts too: the window runs from the start of execute", async () => {
    // No transfer was created yet, but the key was already in play; the lookup at the window's
    // end must settle it, not start a second window.
    const hang = () =>
      new Promise<Response>((_ok, no) =>
        setTimeout(() => no(Object.assign(new Error("aborted"), { name: "AbortError" })), 5),
      );
    const { rail, at } = railOnClock(hang, "USD");
    expect(await rail.execute(instruction)).toEqual({ status: "unknown", detail: "timed out" });
    at(LOOKUP_GRACE_MS - 1);
    expect((await rail.getStatus(instruction.idempotencyKey)).status).toBe("unknown");
    at(LOOKUP_GRACE_MS);
    expect((await rail.getStatus(instruction.idempotencyKey)).status).toBe("failed");
  });
});
