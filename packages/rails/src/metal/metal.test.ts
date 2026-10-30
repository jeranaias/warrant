import { describe, expect, it } from "vitest";
import type { RailInstruction } from "../types.js";
import { MetalAdapter } from "./adapter.js";
import { classifyPay, classifyPull, parseAmountCents } from "./cli.js";
import type { CliResult, CliRunner } from "./cli.js";
import { baseUnitsToCents, centsToBaseUnits, centsToUsdz, usdzToCents } from "./units.js";

// Output shapes from docs.metalntwx.com (metal-agent 0.3.3) and the team's first testnet run.
const TX = "0x" + "ab".repeat(32);
const PAID = `mandate 0x${"1".repeat(64)}
nonce 0x${"2".repeat(64)}
status 200
payer 0x${"a".repeat(40)}
payee 0x${"b".repeat(40)}
amount 0.02 *USDZ
network eip155:63825
transaction ${TX}
explorer https://testnet.metalntwx.com/tx/${TX}
header x-powered-by: Express
body {"rows":[1,2,3]}
`;
const PULL_PAID = `transaction ${TX}
outcome paid
spent 6.5 *USDZ of 10 *USDZ
payer 0x${"a".repeat(40)}
payee 0x${"c".repeat(40)}
amount 0.05 *USDZ
explorer https://testnet.metalntwx.com/tx/${TX}
`;

const res = (over: Partial<CliResult>): CliResult => ({
  code: 0,
  stdout: "",
  stderr: "",
  timedOut: false,
  ...over,
});

describe("units", () => {
  it("cents <-> 18-decimal base units round-trip exactly", () => {
    for (const c of [0, 1, 2, 3, 5, 1000, 2000, 9_007_199_254_740]) {
      expect(baseUnitsToCents(centsToBaseUnits(c))).toBe(c);
    }
    expect(centsToBaseUnits(1)).toBe(10_000_000_000_000_000n);
  });

  it("refuses fractions of a cent and negative or fractional input", () => {
    expect(() => baseUnitsToCents(centsToBaseUnits(1) + 1n)).toThrow(/whole number of cents/);
    expect(() => centsToBaseUnits(1.5)).toThrow();
    expect(() => centsToBaseUnits(-1)).toThrow();
    expect(() => usdzToCents("0.025")).toThrow(/finer than a cent/);
  });

  it("decimal strings for CLI flags and parsing its output", () => {
    expect(centsToUsdz(3)).toBe("0.03");
    expect(centsToUsdz(1000)).toBe("10.00");
    expect(centsToUsdz(0)).toBe("0.00");
    expect(usdzToCents("0.01")).toBe(1);
    expect(usdzToCents("6.5")).toBe(650);
    expect(usdzToCents("10")).toBe(1000);
    expect(usdzToCents("0.050")).toBe(5);
    expect(parseAmountCents("0.01 *USDZ")).toBe(1);
  });
});

describe("classifyPay", () => {
  it("a paid purchase returns the tx and the charged amount", () => {
    expect(classifyPay(res({ stdout: PAID }))).toMatchObject({
      kind: "paid",
      tx: TX,
      amountCents: 2,
    });
  });

  it("a settled payment counts as paid even when the CLI crashes on exit (Windows, exit 127)", () => {
    const o = classifyPay(
      res({
        code: 127,
        stdout: PAID,
        stderr:
          "Assertion failed: !(handle->flags & UV_HANDLE_CLOSING), file src\\win\\async.c, line 76",
      }),
    );
    expect(o).toMatchObject({ kind: "paid", tx: TX });
  });

  it("a 200 without a real settlement hash is not paid", () => {
    const noTx = PAID.replace(/^transaction .*$/m, "transaction pending");
    expect(classifyPay(res({ code: 1, stdout: noTx })).kind).toBe("unknown");
  });

  it("an on-chain mandate refusal is refused with its reason (the 4-cent purchase)", () => {
    const o = classifyPay(
      res({ code: 1, stderr: "error: payment refused: mandate_cap_exceeded; nothing was paid" }),
    );
    expect(o).toEqual({ kind: "refused", reason: "mandate_cap_exceeded" });
  });

  it("an unfunded account is refused (transfer_would_fail)", () => {
    const o = classifyPay(
      res({ code: 1, stderr: "error: payment refused: transfer_would_fail; nothing was paid" }),
    );
    expect(o).toEqual({ kind: "refused", reason: "transfer_would_fail" });
  });

  it("a signed payment whose answer was lost is unknown, never failed", () => {
    const o = classifyPay(
      res({
        code: 1,
        stdout: "nonce 0x99\n",
        stderr: "error: a payment was signed and may have settled",
      }),
    );
    expect(o).toEqual({ kind: "unknown", nonce: "0x99", detail: "signed; outcome not known" });
  });

  it("a timeout after signing is unknown; an unexplained error before signing is refused", () => {
    expect(classifyPay(res({ timedOut: true, stdout: "nonce 0x1\n" })).kind).toBe("unknown");
    expect(classifyPay(res({ code: 1, stderr: "error: boom" }))).toEqual({
      kind: "refused",
      reason: "boom",
    });
    expect(classifyPay(res({ code: 1, stdout: "nonce 0x1\n", stderr: "error: boom" })).kind).toBe(
      "unknown",
    );
  });

  it("error details never echo file paths", () => {
    const o = classifyPay(
      res({ code: 1, stderr: "error: cannot read /home/me/.metal-agent/owner.json" }),
    );
    expect(JSON.stringify(o)).not.toContain(".metal-agent");
  });
});

describe("classifyPull", () => {
  it("paid, already paid, pending, held, refused", () => {
    expect(classifyPull(res({ stdout: PULL_PAID }))).toMatchObject({
      kind: "paid",
      tx: TX,
      amountCents: 5,
    });
    expect(classifyPull(res({ stdout: "outcome already paid, nothing sent\n" })).kind).toBe("paid");
    expect(classifyPull(res({ code: 3, stdout: "outcome pending\n" })).kind).toBe("pending");
    expect(classifyPull(res({ code: 4, stdout: "outcome held\n" })).kind).toBe("held");
    expect(
      classifyPull(
        res({
          code: 1,
          stdout: "outcome refused, not sent\nreason mandate_budget_spent\nrecorded no\n",
        }),
      ),
    ).toEqual({ kind: "refused", reason: "mandate_budget_spent" });
  });

  it("an unexplained exit 1 may have happened after submitting: unknown", () => {
    expect(classifyPull(res({ code: 1, stderr: "error: fetch failed" })).kind).toBe("unknown");
  });
});

describe("MetalAdapter", () => {
  const ins = (over: Partial<RailInstruction> = {}): RailInstruction => ({
    rail: "metal_x402",
    reservationId: "res_1",
    idempotencyKey: "idem-00000001",
    amount: { currency: "USDZ", cents: 2 },
    routingRef: "http://127.0.0.1:4022/data",
    credentialRef: "sourcing.json",
    ...over,
  });

  const fake = (...outputs: CliResult[]) => {
    const calls: string[][] = [];
    const run: CliRunner = (args) => {
      calls.push([...args]);
      return Promise.resolve(outputs.shift() ?? res({ code: 1, stderr: "error: no more" }));
    };
    return { run, calls };
  };

  it("pays a seller URL under the mandate and returns the tx hash", async () => {
    const f = fake(res({ stdout: PAID }));
    const a = new MetalAdapter({ run: f.run, metalHome: "/m", rpcUrl: "https://rpc" });
    const r = await a.execute(ins());
    expect(r).toEqual({ status: "succeeded", railRef: TX, detail: "paid" });
    expect(f.calls[0]?.slice(0, 3)).toEqual(["pay", "http://127.0.0.1:4022/data", "--mandate"]);
  });

  it("refuses before signing when the seller's price differs from what control approved", async () => {
    const f = fake();
    const a = new MetalAdapter({
      run: f.run,
      metalHome: "/m",
      rpcUrl: "https://rpc",
      quote: () => Promise.resolve(4),
    });
    const r = await a.execute(ins());
    expect(r.status).toBe("failed");
    expect(r.detail).toMatch(/price changed/);
    expect(f.calls).toHaveLength(0);
  });

  it("an address routes to mandate pull with the idempotency key as payment id", async () => {
    const f = fake(res({ stdout: PULL_PAID }));
    const a = new MetalAdapter({ run: f.run, metalHome: "/m", rpcUrl: "https://rpc" });
    const to = "0x" + "c".repeat(40);
    const r = await a.execute(ins({ routingRef: to, amount: { currency: "USDZ", cents: 5 } }));
    expect(r.status).toBe("succeeded");
    const args = f.calls[0] ?? [];
    expect(args.slice(0, 2)).toEqual(["mandate", "pull"]);
    expect(args[args.indexOf("--payment-id") + 1]).toBe("idem-00000001");
    expect(args[args.indexOf("--amount") + 1]).toBe("0.05");
  });

  it("a pending payout is re-checked by re-running the same payment id", async () => {
    const f = fake(res({ code: 3, stdout: "outcome pending\n" }), res({ stdout: PULL_PAID }));
    const a = new MetalAdapter({ run: f.run, metalHome: "/m", rpcUrl: "https://rpc" });
    const to = "0x" + "c".repeat(40);
    expect((await a.execute(ins({ routingRef: to }))).status).toBe("pending");
    expect((await a.getStatus("idem-00000001")).status).toBe("succeeded");
    expect(f.calls[1]).toEqual(f.calls[0]);
  });

  it("executing the same key twice never pays twice", async () => {
    const f = fake(res({ stdout: PAID }));
    const a = new MetalAdapter({ run: f.run, metalHome: "/m", rpcUrl: "https://rpc" });
    await a.execute(ins());
    const again = await a.execute(ins());
    expect(again.status).toBe("succeeded");
    expect(f.calls).toHaveLength(1);
  });

  it("an unknown pay keeps its nonce and resolves through the settlement lookup", async () => {
    const f = fake(res({ code: 1, stdout: "nonce 0x77\n", stderr: "error: payment in doubt" }));
    const a = new MetalAdapter({
      run: f.run,
      metalHome: "/m",
      rpcUrl: "https://rpc",
      lookupSettlement: (_url, nonce) =>
        Promise.resolve(nonce === "0x77" ? { status: "succeeded", railRef: TX } : undefined),
    });
    const first = await a.execute(ins());
    expect(first).toMatchObject({ status: "unknown", railRef: "nonce:0x77" });
    expect(await a.getStatus("idem-00000001")).toEqual({ status: "succeeded", railRef: TX });
  });

  it("refuses bad inputs without calling the CLI", async () => {
    const f = fake();
    const a = new MetalAdapter({ run: f.run, metalHome: "/m", rpcUrl: "https://rpc" });
    expect((await a.execute(ins({ credentialRef: "../owner.json" }))).status).toBe("failed");
    const { credentialRef: _c, ...noCred } = ins();
    void _c;
    expect((await a.execute(noCred)).status).toBe("failed");
    expect((await a.execute(ins({ routingRef: "http://evil.example/x" }))).status).toBe("failed");
    expect((await a.execute(ins({ amount: { currency: "USD", cents: 2 } }))).status).toBe("failed");
    expect(f.calls).toHaveLength(0);
  });
});
