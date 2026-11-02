import type { Money } from "@warrant/contracts";
import type { RailAdapter, RailInstruction, RailResult } from "../types.js";

/**
 * Airwallex over REST (legacy shape, no x-api-version), the same calls against the sandbox and
 * `@warrant/mocks` Airwallex. Control is the only caller. Base version (lane B polishes):
 *
 *   AirwallexClient     login once, bearer token, JSON in and out, a timeout on every call
 *   AirwallexTransfers  RailAdapter for `airwallex_transfer`: convert first if the wallet is short,
 *                       then a LOCAL transfer to the payee's beneficiary id
 *   depositEarnings     the sandbox's simulated deposit, with the Metal tx hash as the reference
 *
 * Every write carries a request_id taken from control's idempotency key. A timeout is `unknown`
 * and is looked up by that request_id, never resent (the real API refuses a reused request_id).
 */

/* eslint-disable @typescript-eslint/no-explicit-any */
type Json = Record<string, any>;

export interface AirwallexClientOptions {
  baseUrl: string;
  clientId: string;
  apiKey: string;
  timeoutMs?: number;
  fetch?: typeof fetch;
}

export class AirwallexTimeout extends Error {}

export class AirwallexClient {
  private token: string | undefined;
  private readonly fetch: typeof fetch;

  constructor(private readonly opts: AirwallexClientOptions) {
    this.fetch = opts.fetch ?? fetch;
  }

  async call(
    method: "GET" | "POST",
    path: string,
    body?: Json,
  ): Promise<{ status: number; body: any }> {
    const token = this.token ?? (await this.login());
    const r = await this.send(method, path, { authorization: `Bearer ${token}` }, body);
    if (r.status !== 401) return r;
    this.token = undefined; // expired: log in again once
    const fresh = await this.login();
    return this.send(method, path, { authorization: `Bearer ${fresh}` }, body);
  }

  private async login(): Promise<string> {
    const r = await this.send("POST", "/api/v1/authentication/login", {
      "x-client-id": this.opts.clientId,
      "x-api-key": this.opts.apiKey,
    });
    const token = (r.body as { token?: unknown } | undefined)?.token;
    if (typeof token !== "string") throw new Error(`airwallex login failed (${r.status})`);
    this.token = token;
    return token;
  }

  private async send(
    method: string,
    path: string,
    headers: Record<string, string>,
    body?: Json,
  ): Promise<{ status: number; body: any }> {
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), this.opts.timeoutMs ?? 15_000);
    try {
      const r = await this.fetch(this.opts.baseUrl + path, {
        method,
        headers: { ...headers, ...(body ? { "content-type": "application/json" } : {}) },
        ...(body ? { body: JSON.stringify(body) } : {}),
        signal: ctl.signal,
      });
      const text = await r.text();
      let parsed: unknown;
      try {
        parsed = text ? JSON.parse(text) : undefined;
      } catch {
        parsed = undefined;
      }
      return { status: r.status, body: parsed };
    } catch (e) {
      if ((e as Error).name === "AbortError")
        throw new AirwallexTimeout(`${method} ${path} timed out`);
      throw e;
    } finally {
      clearTimeout(timer);
    }
  }
}

/** 5000 -> "50.00". Integer math only. */
export function major(cents: number): string {
  if (!Number.isSafeInteger(cents) || cents < 0) throw new Error("cents must be a whole number");
  return `${Math.floor(cents / 100)}.${String(cents % 100).padStart(2, "0")}`;
}

/** 50 or "50.00" -> 5000, or undefined. Airwallex answers amounts as numbers in major units. */
export function cents(x: unknown): number | undefined {
  const m = /^(\d+)(?:\.(\d{1,2}))?$/.exec(String(x));
  return m ? Number(m[1] + (m[2] ?? "").padEnd(2, "0")) : undefined;
}

export interface AirwallexTransfersOptions {
  /** The wallet currency sold when the payout currency is short (our earnings land in USD). */
  fundingCurrency: Money["currency"];
  /** Transfer `reason` (one of Airwallex's codes). */
  reason?: string;
  /**
   * Convert the whole payout from the funding currency even when the wallet already holds enough
   * of the payout currency: treasury pays EUR bills out of USD earnings, not out of other euros.
   */
  alwaysConvert?: boolean;
  /**
   * How payouts travel. LOCAL by default. The hackathon sandbox account has no fee set up for EUR
   * LOCAL (`fee_unknown`), so the sandbox scene pays the licensor by SWIFT (ADR-017).
   */
  transferMethod?: "LOCAL" | "SWIFT";
}

/** Transfer status -> control's view. PAID is done; SCHEDULED, PROCESSING and SENT are on the way. */
export function transferStatus(t: Json | undefined): RailResult {
  if (!t || typeof t.id !== "string") return { status: "unknown", detail: "no transfer" };
  const s = String(t.status);
  const railRef = t.id as string;
  if (s === "PAID") return { status: "succeeded", railRef, detail: "PAID" };
  if (s === "FAILED" || s === "CANCELLED") return { status: "failed", railRef, detail: s };
  return { status: "pending", railRef, detail: s };
}

const codeOf = (b: any): string =>
  typeof b?.code === "string" ? String(b.code).slice(0, 60) : "unexpected answer";

export class AirwallexTransfers implements RailAdapter {
  readonly rail = "airwallex_transfer" as const;

  constructor(
    private readonly client: AirwallexClient,
    private readonly opts: AirwallexTransfersOptions,
  ) {}

  async execute(i: RailInstruction): Promise<RailResult> {
    const ccy = i.amount.currency;
    try {
      const gap = this.opts.alwaysConvert
        ? i.amount.cents
        : await this.shortfall(ccy, i.amount.cents);
      if (gap > 0 && ccy !== this.opts.fundingCurrency) {
        const fx = await this.client.call("POST", "/api/v1/fx/conversions/create", {
          request_id: `${i.idempotencyKey}-fx`.slice(0, 64),
          buy_currency: ccy,
          sell_currency: this.opts.fundingCurrency,
          // At least 1.00: the conversion minimum.
          buy_amount: major(Math.max(gap, 100)),
        });
        // A reused request_id means the conversion already ran (a retry): carry on to the transfer.
        const reused = fx.status === 400 && /has been used/.test(String(fx.body?.message ?? ""));
        if (fx.status !== 201 && !reused) {
          return { status: "failed", detail: `conversion refused: ${codeOf(fx.body)}` };
        }
      }
      const r = await this.client.call("POST", "/api/v1/transfers/create", {
        request_id: i.idempotencyKey.slice(0, 50),
        beneficiary_id: i.routingRef,
        transfer_amount: major(i.amount.cents),
        transfer_currency: ccy,
        source_currency: ccy,
        transfer_method: this.opts.transferMethod ?? "LOCAL",
        ...(this.opts.transferMethod === "SWIFT" ? { swift_charge_option: "SHARED" } : {}),
        reason: this.opts.reason ?? "business_expenses",
        reference: `warrant ${i.reservationId}`.slice(0, 140),
      });
      if (r.status === 201) return transferStatus(r.body);
      if (r.body?.code === "duplicate_request_id") return this.getStatus(i.idempotencyKey);
      return { status: "failed", detail: `transfer refused: ${codeOf(r.body)}` };
    } catch (e) {
      if (e instanceof AirwallexTimeout) return { status: "unknown", detail: "timed out" };
      return { status: "unknown", detail: "network error" };
    }
  }

  async getStatus(idempotencyKey: string): Promise<RailResult> {
    try {
      const q = encodeURIComponent(idempotencyKey.slice(0, 50));
      const r = await this.client.call("GET", `/api/v1/transfers?request_id=${q}`);
      const items: Json[] = Array.isArray(r.body?.items) ? r.body.items : [];
      if (r.status === 200 && items.length === 0) {
        return { status: "failed", detail: "no transfer with this key" };
      }
      return transferStatus(items[0]);
    } catch {
      return { status: "unknown", detail: "lookup failed" };
    }
  }

  /** How much of `ccy` the wallet is short of `need`. */
  private async shortfall(ccy: string, need: number): Promise<number> {
    const r = await this.client.call("GET", "/api/v1/balances/current");
    const rows: Json[] = Array.isArray(r.body) ? r.body : [];
    const have = cents(rows.find((x) => x.currency === ccy)?.available_amount) ?? 0;
    return Math.max(0, need - have);
  }
}

/**
 * Earnings swept from Metal arrive in Airwallex. The sandbox cannot receive stablecoins, so this is
 * its simulated deposit, referenced by the Metal transaction hash (ADR-010 #4).
 */
export async function depositEarnings(
  client: AirwallexClient,
  d: { amount: Money; metalTx: string; globalAccountId?: string },
): Promise<{ depositId: string; amount: Money }> {
  // The sandbox deposits into a Global Account (its currency is the account's); the mock takes a
  // bare currency.
  const r = await client.call("POST", "/api/v1/simulation/deposit/create", {
    amount: Number(major(d.amount.cents)),
    ...(d.globalAccountId
      ? {
          global_account_id: d.globalAccountId,
          payer_name: "Warrant treasury",
          payer_country: "US",
        }
      : { currency: d.amount.currency }),
    reference: d.metalTx.slice(0, 140),
  });
  const id = r.body?.deposit_id ?? r.body?.id;
  if (r.status !== 201 || typeof id !== "string") {
    throw new Error(`deposit refused: ${codeOf(r.body)}`);
  }
  return { depositId: id, amount: d.amount };
}

/** The first active Global Account that takes deposits in `currency` (sandbox). */
export async function globalAccountFor(
  client: AirwallexClient,
  currency: string,
): Promise<string | undefined> {
  const r = await client.call("GET", "/api/v1/global_accounts");
  const items: Json[] = Array.isArray(r.body?.items) ? r.body.items : [];
  const hit = items.find(
    (a) =>
      a.status === "ACTIVE" &&
      Array.isArray(a.supported_features) &&
      a.supported_features.some((f: Json) => f.currency === currency && f.type === "DEPOSIT"),
  );
  return typeof hit?.id === "string" ? hit.id : undefined;
}

/** A EUR SEPA beneficiary for a payee (set up once, by the owner, before any warrant names it). */
export async function createEurBeneficiary(
  client: AirwallexClient,
  b: {
    name: string;
    iban: string;
    /** With a BIC the beneficiary takes SWIFT payouts instead of LOCAL. */
    swiftCode?: string;
    address: { street: string; city: string; state?: string; postcode: string; country: string };
  },
): Promise<string> {
  const r = await client.call("POST", "/api/v1/beneficiaries/create", {
    beneficiary: {
      entity_type: "COMPANY",
      type: "BANK_ACCOUNT",
      company_name: b.name,
      bank_details: {
        account_currency: "EUR",
        account_name: b.name,
        bank_country_code: b.iban.slice(0, 2),
        iban: b.iban,
        ...(b.swiftCode ? { swift_code: b.swiftCode } : {}),
      },
      address: {
        street_address: b.address.street,
        city: b.address.city,
        ...(b.address.state ? { state: b.address.state } : {}),
        postcode: b.address.postcode,
        country_code: b.address.country,
      },
    },
    transfer_methods: [b.swiftCode ? "SWIFT" : "LOCAL"],
    nickname: b.name,
  });
  if (r.status !== 201 || typeof r.body?.id !== "string") {
    throw new Error(`beneficiary refused: ${codeOf(r.body)}`);
  }
  return r.body.id;
}

/** The sandbox moves a transfer along (SENT, then PAID). Sandbox and mock only. */
export async function simulateTransfer(
  client: AirwallexClient,
  transferId: string,
  next: "PROCESSING" | "SENT" | "PAID",
): Promise<string> {
  const r = await client.call(
    "POST",
    `/api/v1/simulation/transfers/${encodeURIComponent(transferId)}/transition`,
    { next_status: next },
  );
  return String(r.body?.status ?? r.status);
}
