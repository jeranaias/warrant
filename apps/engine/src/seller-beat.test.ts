import type { Server } from "node:http";
import { afterEach, describe, expect, it } from "vitest";
import { createEngine } from "./server.js";

type Logged = { event: { type: string } & Record<string, unknown> };

let server: Server | undefined;
afterEach(() => new Promise<void>((ok) => (server ? server.close(() => ok()) : ok())));

async function start() {
  const { app } = createEngine({ scenario: "none" });
  server = app.listen(0, "127.0.0.1");
  await new Promise<void>((ok) => server?.once("listening", () => ok()));
  const a = server.address();
  const base = `http://127.0.0.1:${typeof a === "object" && a ? a.port : 0}`;
  const events = async () =>
    ((await (await fetch(`${base}/events`)).json()) as { events: Logged[] }).events.map(
      (l) => l.event,
    );
  const post = (path: string, body: unknown) =>
    fetch(base + path, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
  return { base, events, post };
}

describe("the seller's side in the mock world", () => {
  it("loading 'all' runs a buyer with a pass and one without through the store's checker", async () => {
    const e = await start();
    await e.post("/scenario", { name: "all" });
    const checks = (await e.events()).filter((x) => x.type === "pass_checked");
    expect(checks.map((c) => c["ok"])).toEqual([true, false]);
    const buyer = checks[0]?.["buyer"] as { ownerId: string; mandateId?: string } | undefined;
    expect(buyer?.ownerId).toBe("own_customer");
    expect(buyer?.mandateId).toMatch(/^0x[0-9a-f]{64}$/);
    expect(checks[1]?.["problems"]).toEqual([
      "no warrant pass: nothing shows an owner authorized this",
    ]);
  });

  it("'normal' has only the authorized buyer; 'attacks' only the unauthorized one", async () => {
    const e = await start();
    await e.post("/scenario", { name: "normal" });
    await e.post("/scenario", { name: "attacks" });
    const oks = (await e.events()).filter((x) => x.type === "pass_checked").map((c) => c["ok"]);
    expect(oks).toEqual([true, false]);
  });

  it("support picking up a dispute ticket gets the store's decision in the event log", async () => {
    const e = await start();
    await e.post("/scenario", { name: "dispute" });
    await fetch(`${e.base}/tasks?role=support`);
    let decided: Logged["event"] | undefined;
    for (let i = 0; i < 20 && !decided; i++) {
      decided = (await e.events()).find((x) => x.type === "dispute_decided");
      if (!decided) await new Promise((ok) => setTimeout(ok, 25));
    }
    expect(decided?.["orders"]).toEqual([
      expect.objectContaining({ orderId: "ord_1", reason: "data_was_wrong", verified: true }),
    ]);
  });
});
