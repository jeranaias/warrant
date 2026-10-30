import { createHash } from "node:crypto";

/** Same shape as `@warrant/rails` CliResult / CliRunner (mocks imports contracts only). */
export interface CliResult {
  code: number;
  stdout: string;
  stderr: string;
  timedOut: boolean;
}
export type CliRunner = (args: readonly string[], timeoutMs: number) => Promise<CliResult>;

/**
 * In-memory stand-in for Metal testnet and the `metal-agent` CLI (RAILS_MODE=mock, tests, bench).
 * It enforces mandates the way the chain does (payees, cap, budget, revoked, expired, balance)
 * and prints the CLI's `key value` output, so the real parsers in packages/rails run unchanged.
 */

export interface MockSale {
  payer: string;
  payTo: string;
  cents: number;
  tx: string;
  nonce: string;
  mandateId: string;
  /** The buyer's signed offer for this payment (opaque text, like signedOfferOf()). */
  signedOffer: string;
  /** Headers sent with the paid request (`--header 'name: value'`), names lower-cased. */
  headers: Record<string, string>;
}

export interface MockSeller {
  /** Exact URL the buyer pays (`pay <url>`). */
  url: string;
  payTo: string;
  /** Current price in cents. */
  price(): number;
  /** Called once the payment settled; returns the response body. Throw to answer 503. */
  deliver(sale: MockSale): string;
}

export interface MockMandateSpec {
  /** Credential file name inside METAL_HOME, e.g. "sourcing.json". */
  credential: string;
  principal: string;
  capCents: number;
  budgetCents: number;
  /** Allowed payee addresses; empty or absent = any. */
  payees?: string[];
  expiresAt: Date;
}

export interface MockMandate extends MockMandateSpec {
  mandateId: string;
  spentCents: number;
  payments: number;
  revoked: boolean;
  successor?: string;
}

export interface MockTx {
  hash: string;
  kind: "payment" | "pull";
  from: string;
  to: string;
  cents: number;
  mandateId: string;
  nonce: string;
  signedOffer?: string;
  at: string;
}

export interface MockRefusal {
  mandateId: string;
  reason: string;
  to: string;
  cents: number;
  at: string;
}

const lower = (a: string) => a.toLowerCase();

export class MockMetalChain {
  readonly txs: MockTx[] = [];
  readonly refusals: MockRefusal[] = [];
  private readonly balances = new Map<string, number>();
  private readonly mandates = new Map<string, MockMandate>();
  private readonly sellers = new Map<string, MockSeller>();
  private readonly pulls = new Map<string, MockTx>();
  private seq = 0;
  /** Test hook: the next `pay` signs and then loses its answer ("may have settled"). */
  loseNextPayAnswer = false;

  constructor(private readonly clock: () => Date = () => new Date()) {}

  fund(address: string, cents: number): void {
    this.balances.set(lower(address), this.balanceOf(address) + cents);
  }

  balanceOf(address: string): number {
    return this.balances.get(lower(address)) ?? 0;
  }

  addSeller(seller: MockSeller): void {
    this.sellers.set(normalizeUrl(seller.url), seller);
  }

  addMandate(spec: MockMandateSpec): MockMandate {
    if (this.mandates.has(spec.credential)) {
      throw new Error(`${spec.credential} already exists`); // the CLI never overwrites one
    }
    const m: MockMandate = {
      ...spec,
      mandateId: this.hex(`mandate:${spec.credential}:${this.seq++}`),
      spentCents: 0,
      payments: 0,
      revoked: false,
    };
    this.mandates.set(spec.credential, m);
    return m;
  }

  /** `mandate replace`: spend carries forward, so the new budget must exceed it; old is revoked. */
  replaceMandate(oldCredential: string, spec: MockMandateSpec): MockMandate {
    const old = this.mandate(oldCredential);
    if (old.revoked) throw new Error("mandate_revoked");
    if (spec.budgetCents <= old.spentCents) throw new Error("budget must exceed spend");
    const next = this.addMandate(spec);
    next.spentCents = old.spentCents;
    next.payments = old.payments;
    old.revoked = true;
    old.successor = next.mandateId;
    return next;
  }

  revokeMandate(credential: string): void {
    this.mandate(credential).revoked = true;
  }

  mandate(credential: string): MockMandate {
    const m = this.mandates.get(credential);
    if (!m) throw new Error(`no mandate ${credential}`);
    return m;
  }

  mandateList(): MockMandate[] {
    return [...this.mandates.values()];
  }

  tx(hash: string): MockTx | undefined {
    return this.txs.find((t) => t.hash === hash);
  }

  /** Facilitator `/settlements` lookup by nonce. */
  settlementByNonce(nonce: string): MockTx | undefined {
    return this.txs.find((t) => t.nonce === nonce);
  }

  /** A CliRunner that answers like `metal-agent` 0.3.3. */
  runner(): CliRunner {
    return (args) => Promise.resolve(this.run(args));
  }

  private run(args: readonly string[]): CliResult {
    const flag = (name: string) => {
      const i = args.indexOf(name);
      return i >= 0 ? args[i + 1] : undefined;
    };
    if (args[0] === "pay") {
      const headers: Record<string, string> = {};
      args.forEach((a, i) => {
        const h = a === "--header" ? args[i + 1] : undefined;
        const at = h?.indexOf(":") ?? -1;
        if (h && at > 0) headers[h.slice(0, at).trim().toLowerCase()] = h.slice(at + 1).trim();
      });
      return this.pay(args[1] ?? "", credName(flag("--mandate")), headers);
    }
    if (args[0] === "mandate" && args[1] === "pull") {
      return this.pull(
        credName(flag("--credential")),
        flag("--to") ?? "",
        flag("--amount") ?? "",
        flag("--payment-id"),
      );
    }
    return out(1, "", `error: mock does not implement ${args.slice(0, 2).join(" ")}`);
  }

  private check(m: MockMandate, to: string, cents: number): string | undefined {
    const now = this.clock();
    if (m.revoked) return "mandate_revoked";
    if (now > m.expiresAt) return "mandate_expired";
    if (m.payees && m.payees.length > 0 && !m.payees.map(lower).includes(lower(to))) {
      return "mandate_payee_not_listed";
    }
    if (cents > m.capCents) return "mandate_cap_exceeded";
    if (m.spentCents + cents > m.budgetCents) return "mandate_budget_spent";
    if (this.balanceOf(m.principal) < cents) return "transfer_would_fail";
    return undefined;
  }

  private pay(
    url: string,
    cred: string | undefined,
    headers: Record<string, string> = {},
  ): CliResult {
    const seller = this.sellers.get(normalizeUrl(url));
    if (!seller)
      return out(1, "", "error: fetch failed (no seller at that URL); nothing was signed");
    const m = cred ? this.mandates.get(cred) : undefined;
    if (!m) return out(1, "", "error: cannot read credential; nothing was signed");
    const cents = seller.price();
    const refusal = this.check(m, seller.payTo, cents);
    if (refusal) {
      this.refusals.push({
        mandateId: m.mandateId,
        reason: refusal,
        to: seller.payTo,
        cents,
        at: this.clock().toISOString(),
      });
      return out(1, "", `error: payment refused: ${refusal}; nothing was paid`);
    }
    const nonce = this.hex(`nonce:${this.seq++}`);
    const signedOffer = JSON.stringify({ mock: true, mandate: m.mandateId, nonce, url, cents });
    const tx = this.move("payment", m, seller.payTo, cents, nonce, signedOffer);
    let body: string;
    try {
      body = seller.deliver({
        payer: m.principal,
        payTo: seller.payTo,
        cents,
        tx: tx.hash,
        nonce,
        mandateId: m.mandateId,
        signedOffer,
        headers,
      });
    } catch {
      this.undo(tx, m); // x402: a handler error >= 400 cancels the payment
      return out(
        1,
        `nonce ${nonce}\nstatus 503\n`,
        "error: payment refused: seller_error; nothing was paid",
      );
    }
    if (this.loseNextPayAnswer) {
      this.loseNextPayAnswer = false;
      return out(1, `nonce ${nonce}\n`, "error: a payment was signed and may have settled");
    }
    return out(
      0,
      [
        `mandate ${m.mandateId}`,
        `nonce ${nonce}`,
        "status 200",
        `payer ${m.principal}`,
        `payee ${seller.payTo}`,
        `amount ${usdz(cents)} *USDZ`,
        "network eip155:63825",
        `transaction ${tx.hash}`,
        `explorer https://testnet.metalntwx.com/tx/${tx.hash}`,
        `body ${body}`,
        "",
      ].join("\n"),
      "",
    );
  }

  private pull(
    cred: string | undefined,
    to: string,
    amount: string,
    paymentId?: string,
  ): CliResult {
    const m = cred ? this.mandates.get(cred) : undefined;
    if (!m) return out(1, "", "error: cannot read credential");
    const key = paymentId ? `${m.mandateId}:${paymentId}` : undefined;
    const prior = key ? this.pulls.get(key) : undefined;
    if (prior) return out(0, `transaction ${prior.hash}\noutcome already paid, nothing sent\n`, "");
    const cents = Math.round(Number(amount) * 100);
    if (!/^\d+(\.\d{1,2})?$/.test(amount)) return out(1, "", "error: amount must be whole cents");
    const refusal = this.check(m, to, cents);
    if (refusal) {
      this.refusals.push({
        mandateId: m.mandateId,
        reason: refusal,
        to,
        cents,
        at: this.clock().toISOString(),
      });
      return out(1, `outcome refused, not sent\nreason ${refusal}\nrecorded no\n`, "");
    }
    const tx = this.move("pull", m, to, cents, this.hex(`pull:${this.seq++}`));
    if (key) this.pulls.set(key, tx);
    return out(
      0,
      [
        `transaction ${tx.hash}`,
        "outcome paid",
        `spent ${usdz(m.spentCents)} *USDZ of ${usdz(m.budgetCents)} *USDZ`,
        `payer ${m.principal}`,
        `payee ${to}`,
        `amount ${usdz(cents)} *USDZ`,
        `explorer https://testnet.metalntwx.com/tx/${tx.hash}`,
        "",
      ].join("\n"),
      "",
    );
  }

  private move(
    kind: MockTx["kind"],
    m: MockMandate,
    to: string,
    cents: number,
    nonce: string,
    signedOffer?: string,
  ): MockTx {
    this.balances.set(lower(m.principal), this.balanceOf(m.principal) - cents);
    this.fund(to, cents);
    m.spentCents += cents;
    m.payments += 1;
    const tx: MockTx = {
      hash: this.hex(`tx:${this.seq++}`),
      kind,
      from: m.principal,
      to,
      cents,
      mandateId: m.mandateId,
      nonce,
      ...(signedOffer ? { signedOffer } : {}),
      at: this.clock().toISOString(),
    };
    this.txs.push(tx);
    return tx;
  }

  private undo(tx: MockTx, m: MockMandate): void {
    this.balances.set(lower(m.principal), this.balanceOf(m.principal) + tx.cents);
    this.balances.set(lower(tx.to), this.balanceOf(tx.to) - tx.cents);
    m.spentCents -= tx.cents;
    m.payments -= 1;
    this.txs.splice(this.txs.indexOf(tx), 1);
  }

  private hex(seed: string): string {
    return "0x" + createHash("sha256").update(`mock-metal:${seed}`).digest("hex");
  }
}

/** A deterministic, valid-looking address for a mock account name. */
export function mockAddress(name: string): string {
  return "0x" + createHash("sha256").update(`mock-address:${name}`).digest("hex").slice(0, 40);
}

function credName(path: string | undefined): string | undefined {
  if (!path) return undefined;
  return path.split(/[/\\]/).pop();
}

function normalizeUrl(u: string): string {
  try {
    return new URL(u).toString();
  } catch {
    return u;
  }
}

function usdz(cents: number): string {
  return `${Math.floor(cents / 100)}.${String(cents % 100).padStart(2, "0")}`;
}

function out(code: number, stdout: string, stderr: string): CliResult {
  return { code, stdout, stderr, timedOut: false };
}

/**
 * The upstream data provider our sourcing agent buys from (Kit 11). It charges 2 cents per
 * call, until the owner of the scene raises it to 4: over sourcing's 3-cent cap, so our rules
 * refuse it, and so does the mandate on chain when a payment goes around our rules.
 */
export const UPSTREAM_URL = "http://127.0.0.1:4022/forecast/eurusd";
export const UPSTREAM_PAY_TO = mockAddress("upstream");

export interface Upstream extends MockSeller {
  setPrice(cents: number): void;
  readonly sales: MockSale[];
}

export function addUpstream(chain: MockMetalChain, startCents = 2): Upstream {
  let price = startCents;
  let batch = 0;
  const sales: MockSale[] = [];
  const upstream: Upstream = {
    url: UPSTREAM_URL,
    payTo: UPSTREAM_PAY_TO,
    price: () => price,
    setPrice: (cents) => {
      if (!Number.isInteger(cents) || cents <= 0) throw new Error("price must be whole cents > 0");
      price = cents;
    },
    sales,
    deliver: (sale) => {
      sales.push(sale);
      return JSON.stringify({ batchId: `ub_${++batch}`, pair: "EURUSD", rate: 1.0842 });
    },
  };
  chain.addSeller(upstream);
  return upstream;
}
