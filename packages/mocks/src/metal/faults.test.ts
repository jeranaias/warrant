import { describe, expect, it } from "vitest";
import {
  MockMetalChain,
  UPSTREAM_PAY_TO,
  UPSTREAM_URL,
  addUpstream,
  mockAddress,
  startMetalMock,
} from "./index.js";

/** Issue #14: every fault the mock seller and chain can inject, and whether money moved. */

const PRINCIPAL = mockAddress("owner");

function setup() {
  let now = Date.parse("2026-11-01T12:00:00Z");
  const chain = new MockMetalChain(() => new Date(now));
  chain.fund(PRINCIPAL, 100);
  const upstream = addUpstream(chain, 2);
  chain.addMandate({
    credential: "sourcing.json",
    principal: PRINCIPAL,
    capCents: 3,
    budgetCents: 10,
    payees: [UPSTREAM_PAY_TO],
    expiresAt: new Date("2026-11-20T00:00:00Z"),
  });
  const run = chain.runner();
  const pay = () => run(["pay", UPSTREAM_URL, "--mandate", "home/sourcing.json"], 1000);
  const pull = (id: string) =>
    run(
      ["mandate", "pull", "--credential", "home/sourcing.json", "--to", UPSTREAM_PAY_TO].concat([
        "--amount",
        "0.02",
        "--payment-id",
        id,
      ]),
      1000,
    );
  const later = (ms: number) => (now += ms);
  const spent = () => chain.mandate("sourcing.json").spentCents;
  return { chain, upstream, pay, pull, later, spent };
}

const nonceOf = (stdout: string) => /^nonce (\S+)$/m.exec(stdout)?.[1] ?? "";

describe("mock Metal faults: pay", () => {
  it("5xx: the seller errors, x402 cancels the payment, nothing is paid", async () => {
    const { chain, pay, spent } = setup();
    chain.fault({ kind: "5xx", status: 502 });
    const r = await pay();
    expect(r.code).toBe(1);
    expect(r.stdout).toMatch(/^status 502$/m);
    expect(r.stderr).toMatch(/payment refused: seller_error; nothing was paid/);
    expect(chain.txs).toHaveLength(0);
    expect(spent()).toBe(0);
    expect((await pay()).code).toBe(0); // it hit once
  });

  it("refuse: the seller turns the request away (even with a valid pass), nothing is paid", async () => {
    const { chain, pay } = setup();
    chain.fault({ kind: "refuse", reason: "warrant pass not accepted" });
    const r = await pay();
    expect(r.stdout).toMatch(/^status 403$/m);
    expect(r.stderr).toMatch(/seller_refused \(warrant pass not accepted\); nothing was paid/);
    expect(chain.txs).toHaveLength(0);
  });

  it("bad-requirements: an expired or invalid 402 is never signed", async () => {
    const { chain, pay } = setup();
    chain.fault({ kind: "bad-requirements" });
    chain.fault({ kind: "bad-requirements", reason: "invalid" });
    expect((await pay()).stderr).toMatch(/payment requirements expired; nothing was signed/);
    expect((await pay()).stderr).toMatch(/invalid payment requirements; nothing was signed/);
    expect(chain.txs).toHaveLength(0);
  });

  it("price-change: quoted 2 cents, charges what the fault says; the mandate still caps it", async () => {
    const { chain, pay, spent } = setup();
    expect(chain.quote(UPSTREAM_URL)).toBe(2);
    chain.fault({ kind: "price-change", cents: 3 });
    expect((await pay()).stdout).toMatch(/^amount 0\.03 \*USDZ$/m);
    chain.fault({ kind: "price-change", cents: 4 });
    expect((await pay()).stderr).toMatch(/mandate_cap_exceeded/);
    expect(spent()).toBe(3);
  });

  it("duplicate: the answer arrives twice, one payment on chain", async () => {
    const { chain, pay, spent } = setup();
    chain.fault({ kind: "duplicate" });
    const r = await pay();
    expect(r.stdout.match(/^transaction /gm)).toHaveLength(2);
    expect(chain.txs).toHaveLength(1);
    expect(spent()).toBe(2);
  });

  it("timeout before signing: killed, no nonce, nothing paid", async () => {
    const { chain, pay } = setup();
    chain.fault({ kind: "timeout" });
    expect(await pay()).toMatchObject({ timedOut: true, stdout: "" });
    expect(chain.txs).toHaveLength(0);
  });

  it("timeout after settling: killed with the nonce printed, and the lookup finds it", async () => {
    const { chain, pay } = setup();
    chain.fault({ kind: "timeout", settled: true });
    const r = await pay();
    expect(r.timedOut).toBe(true);
    expect(chain.settlementByNonce(nonceOf(r.stdout))?.cents).toBe(2);
  });

  it("answer-lost: paid, the CLI says it may have settled", async () => {
    const { chain, pay } = setup();
    chain.fault({ kind: "answer-lost" });
    const r = await pay();
    expect(r.stderr).toMatch(/may have settled/);
    expect(chain.settlementByNonce(nonceOf(r.stdout))?.cents).toBe(2);
  });

  it("slow-settle: the facilitator shows the payment only after the delay", async () => {
    const { chain, pay, later } = setup();
    chain.fault({ kind: "slow-settle", ms: 5_000 });
    const nonce = nonceOf((await pay()).stdout);
    expect(chain.settlementByNonce(nonce)).toBeUndefined();
    later(5_000);
    expect(chain.settlementByNonce(nonce)?.cents).toBe(2);
  });

  it("a fault can target one url and several runs", async () => {
    const { chain, pay } = setup();
    chain.fault({ kind: "5xx", url: "http://127.0.0.1:4022/other" });
    expect((await pay()).code).toBe(0);
    chain.fault({ kind: "5xx", url: UPSTREAM_URL, times: 2 });
    expect((await pay()).code).toBe(1);
    expect((await pay()).code).toBe(1);
    expect((await pay()).code).toBe(0);
  });
});

describe("mock Metal faults: mandate pull", () => {
  it("a timeout after sending is settled by re-running the same payment id", async () => {
    const { chain, pull } = setup();
    chain.fault({ command: "pull", kind: "timeout", settled: true });
    expect((await pull("p-1")).timedOut).toBe(true);
    expect((await pull("p-1")).stdout).toMatch(/already paid, nothing sent/);
    expect(chain.txs).toHaveLength(1);
  });

  it("an RPC 5xx sends nothing, and the retry pays once", async () => {
    const { chain, pull } = setup();
    chain.fault({ command: "pull", kind: "5xx" });
    expect((await pull("p-2")).stderr).toMatch(/rpc answered 503; not sent/);
    expect(chain.txs).toHaveLength(0);
    expect((await pull("p-2")).stdout).toMatch(/^outcome paid$/m);
    expect(chain.txs).toHaveLength(1);
  });

  it("a pay fault does not hit a pull", async () => {
    const { chain, pull } = setup();
    chain.fault({ kind: "5xx" });
    expect((await pull("p-3")).code).toBe(0);
  });
});

describe("mock Metal over HTTP", () => {
  it("answers 402 with the price, takes price and fault switches, finds settlements", async () => {
    const { chain, upstream, pay } = setup();
    const m = await startMetalMock({ chain, upstream });
    try {
      const quote = async () => {
        const res = await fetch(`${m.url}/forecast/eurusd`);
        expect(res.status).toBe(402);
        const req = JSON.parse(
          Buffer.from(res.headers.get("payment-required") ?? "", "base64").toString(),
        ) as { accepts: { scheme: string; network: string; amount: string }[] };
        return req.accepts[0];
      };
      expect(await quote()).toMatchObject({
        scheme: "exact",
        network: "eip155:63825",
        amount: "20000000000000000", // 2 cents in USDZ base units
      });
      const post = (path: string, body: unknown) =>
        fetch(`${m.url}${path}`, { method: "POST", body: JSON.stringify(body) });
      expect((await post("/_mock/price", { cents: 4 })).status).toBe(200);
      expect((await quote())?.amount).toBe("40000000000000000");
      expect((await post("/_mock/price", { cents: 0 })).status).toBe(400);
      await post("/_mock/price", { cents: 2 });

      expect((await post("/_mock/fault", {})).status).toBe(400);
      expect((await post("/_mock/fault", { kind: "answer-lost" })).status).toBe(200);
      const nonce = nonceOf((await pay()).stdout);
      const found = await fetch(`${m.url}/settlements?nonce=${nonce}`);
      expect(found.status).toBe(200);
      expect(((await found.json()) as { cents: number }).cents).toBe(2);
      expect((await fetch(`${m.url}/settlements?nonce=0x00`)).status).toBe(404);
      const state = (await (await fetch(`${m.url}/_mock/state`)).json()) as { txs: unknown[] };
      expect(state.txs).toHaveLength(1);
    } finally {
      await m.close();
    }
  });
});
