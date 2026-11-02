import { describe, expect, it } from "vitest";
import { AirwallexClient, AirwallexTransfers, cents, major, transferStatus } from "./index.js";

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
});
