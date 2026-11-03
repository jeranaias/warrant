import { createHash, generateKeyPairSync } from "node:crypto";
import type { KeyObject } from "node:crypto";
import type {
  AgentRole,
  BudgetChangeProposal,
  MandateRef,
  Money,
  PaymentSummary,
  PurposeVerdict,
  SignedOrderRecord,
  Warrant,
  WarrantBody,
} from "@warrant/contracts";
import {
  AGENT_BUDGETS,
  QUERY_PRICE,
  TOTAL_BUDGET,
  canonicalHash,
  encodePass,
  PassChecker,
  issueGrant,
  issuePass,
  keyB64,
  signWarrant,
} from "@warrant/control";
import type { ControlEvent, PassCheckedEvent, PurposeChecker } from "@warrant/control";
import { MetalAdapter, classifyPay, classifyPull } from "@warrant/rails";
import type {
  CardControls,
  CliResult,
  CliRunner,
  RailAdapter,
  RailInstruction,
  RailResult,
} from "@warrant/rails";
import type { Rail } from "@warrant/contracts";
import { MockMetalChain, UPSTREAM_PAY_TO, UPSTREAM_URL, addUpstream } from "@warrant/mocks/metal";

/**
 * The engine's pretend world: an owner, four signed warrants, three stored orders, a mock Metal
 * chain that enforces each agent's mandate (with the upstream provider selling on it) and an
 * Airwallex rail that always succeeds. Everything is in memory and made fresh at startup. Nothing
 * here touches a real key, account or network. `live.ts` builds the same World on the real Metal
 * testnet (RAILS_MODE=sandbox).
 */

const eur = (cents: number): Money => ({ currency: "EUR", cents });
const usd = (cents: number): Money => ({ currency: "USD", cents });
const addr = (c: string) => "0x" + c.repeat(40);

export const OWNER_ID = "own_demo";
export const CUSTOMER_ADDRESS = addr("c");
const STORE_ADDRESS = addr("5");
const PRINCIPAL = addr("a");
/** Our treasury's own Metal address: earnings land here before the Airwallex deposit. */
const TREASURY_ADDRESS = addr("7");

export interface AgentIdentity {
  role: AgentRole;
  agentId: string;
  warrantId: string;
  /** Treasury: the warrant its sweeps go under (ADR-022). */
  sweepWarrantId?: string;
}

export const AGENTS: Record<AgentRole, AgentIdentity> = {
  sourcing: { role: "sourcing", agentId: "agt_sourcing", warrantId: "wrt_sourcing" },
  support: { role: "support", agentId: "agt_support", warrantId: "wrt_support" },
  treasury: {
    role: "treasury",
    agentId: "agt_treasury",
    warrantId: "wrt_treasury",
    sweepWarrantId: "wrt_treasury_sweep",
  },
};

/**
 * Treasury's second warrant: the company's virtual Visa card (Kit 2), for one software seat. Its
 * cap and budget are copied onto the card itself, so the card network enforces them too.
 */
export const CARD_WARRANT_ID = "wrt_treasury_card";
export const CARD_SEAT = {
  payeeId: "pay_design_tool",
  displayName: "Design tool seat",
  routingRef: "merchant_design_tool",
  /** ISO 18245: computer software stores. */
  merchantCategoryCode: "5734",
  price: usd(1200),
};
const CARD_CAP = usd(1500);
const CARD_BUDGET = usd(5000);

/**
 * Treasury's third warrant (ADR-022): move the store's earnings from Metal toward Airwallex. One
 * payee, our own treasury address; every sweep waits for the owner. Its mandate pays from the
 * store's account, which holds the earnings.
 */
export const SWEEP_WARRANT_ID = AGENTS.treasury.sweepWarrantId ?? "wrt_treasury_sweep";
export const SWEEP_PAYEE_ID = "pay_treasury";

/** The two agents that pay on Metal, each through its own mandate. */
export type MetalRole = "sourcing" | "support";
export const METAL_ROLES: readonly MetalRole[] = ["sourcing", "support"];

/** What the Metal warrants sit on: the mock's demo values, or the chain's in sandbox mode. */
export interface MetalTerms {
  /** The upstream provider's x402 URL (sourcing's one payee). */
  upstreamUrl: string;
  mandates: Record<MetalRole, { version: number; mandate: MandateRef }>;
  /** Treasury's sweep mandate (ADR-022). Mock only for now: the sandbox world has none yet. */
  sweep?: { version: number; mandate: MandateRef };
}

const DEMO_EXPIRY = "2026-11-20T00:00:00Z";

function demoTerms(): MetalTerms {
  const on = (role: MetalRole) => ({
    version: 1,
    mandate: {
      network: "eip155:63825" as const,
      mandateId: "mnd_demo",
      principal: PRINCIPAL,
      cap: AGENT_BUDGETS[role].perPaymentCap,
      budget: AGENT_BUDGETS[role].budget,
      expiresAt: DEMO_EXPIRY,
    },
  });
  return {
    upstreamUrl: UPSTREAM_URL,
    mandates: { sourcing: on("sourcing"), support: on("support") },
    sweep: {
      version: 1,
      mandate: {
        ...on("sourcing").mandate,
        principal: STORE_ADDRESS,
        cap: AGENT_BUDGETS.treasury.perPaymentCap,
        budget: AGENT_BUDGETS.treasury.budget,
      },
    },
  };
}

/** A Metal warrant's limits and expiry are its mandate's (ADR-009 #2). */
function onMandate(t: { version: number; mandate: MandateRef }) {
  const { mandate } = t;
  return {
    version: t.version,
    perPaymentCap: mandate.cap,
    totalBudget: mandate.budget,
    expiresAt: mandate.expiresAt,
    mandate,
  };
}

export function bodies(
  now: Date,
  terms: MetalTerms = demoTerms(),
  licensorRef = "ben_licensor",
  card = false,
): WarrantBody[] {
  const notBefore = new Date(now.getTime() - 60_000).toISOString();
  const common = { version: 1, ownerId: OWNER_ID, notBefore, expiresAt: DEMO_EXPIRY };
  return [
    {
      ...common,
      agentId: AGENTS.sourcing.agentId,
      warrantId: AGENTS.sourcing.warrantId,
      agentRole: "sourcing",
      purpose: "Buy upstream market data to resell to our customers.",
      allowedRails: ["metal_x402"],
      payees: [
        {
          payeeId: "pay_upstream",
          displayName: "Upstream data provider",
          rail: "metal_x402",
          routingRef: terms.upstreamUrl,
          currency: "USDZ",
        },
      ],
      ...onMandate(terms.mandates.sourcing),
    },
    {
      ...common,
      agentId: AGENTS.support.agentId,
      warrantId: AGENTS.support.warrantId,
      agentRole: "support",
      purpose: "Refund customers for orders we got wrong, never more than they paid.",
      allowedRails: ["metal_x402"],
      payees: [],
      ...onMandate(terms.mandates.support),
    },
    {
      // Treasury's bills: the EUR licence fee. Its sweep has its own Metal warrant (ADR-022).
      ...common,
      agentId: AGENTS.treasury.agentId,
      warrantId: AGENTS.treasury.warrantId,
      agentRole: "treasury",
      purpose: "Pay the monthly data licence fee in euros.",
      allowedRails: ["airwallex_transfer"],
      payees: [
        {
          payeeId: "pay_licensor",
          displayName: "Data licensor (EUR)",
          rail: "airwallex_transfer",
          routingRef: licensorRef,
          currency: "EUR",
          billingPeriod: "month",
        },
      ],
      perPaymentCap: eur(5000),
      totalBudget: eur(10000),
    },
    ...(card ? [cardBody(common)] : []),
    ...(terms.sweep
      ? [
          {
            ...common,
            agentId: AGENTS.treasury.agentId,
            warrantId: SWEEP_WARRANT_ID,
            agentRole: "treasury" as const,
            purpose: "Move the store's earnings to our own treasury address, then to Airwallex.",
            allowedRails: ["metal_x402" as const],
            payees: [
              {
                payeeId: SWEEP_PAYEE_ID,
                displayName: "Our treasury (to Airwallex)",
                rail: "metal_x402" as const,
                routingRef: TREASURY_ADDRESS,
                currency: "USDZ" as const,
                ownerApprovesEach: true as const,
              },
            ],
            ...onMandate(terms.sweep),
          },
        ]
      : []),
  ];
}

/** Treasury's card warrant: one payee, the design tool seat, billed monthly. */
function cardBody(common: Pick<WarrantBody, "version" | "ownerId" | "notBefore" | "expiresAt">) {
  return {
    ...common,
    agentId: AGENTS.treasury.agentId,
    warrantId: CARD_WARRANT_ID,
    agentRole: "treasury" as const,
    purpose: "Pay for the design tool seat our team uses, on the company card.",
    allowedRails: ["airwallex_card" as const],
    payees: [
      {
        payeeId: CARD_SEAT.payeeId,
        displayName: CARD_SEAT.displayName,
        rail: "airwallex_card" as const,
        routingRef: CARD_SEAT.routingRef,
        currency: "USD" as const,
        billingPeriod: "month" as const,
        merchantCategoryCode: CARD_SEAT.merchantCategoryCode,
      },
    ],
    perPaymentCap: CARD_CAP,
    totalBudget: CARD_BUDGET,
  };
}

/** The upstream batch that went out stale: data we sold from it was wrong (the dispute beat). */
export const BAD_BATCH = "bat_stale";
const ORDER_BATCHES: Record<string, string> = {
  ord_1: BAD_BATCH,
  ord_2: "bat_good",
  ord_3: "bat_good",
};
const STORE_QUERY_URL = "http://127.0.0.1:4021/query/fx-eurusd";

/**
 * The customer's own warrant: their owner signed a grant for data purchases from our store, and
 * their control signed a pass for each purchase. The store kept each pass with the order.
 */
function customerPasses(at: Date) {
  const owner = generateKeyPairSync("ed25519");
  const control = generateKeyPairSync("ed25519");
  const grant = issueGrant(
    {
      grantId: "grt_customer",
      warrantId: "wrt_customer",
      warrantVersion: 1,
      ownerId: "own_customer",
      payer: CUSTOMER_ADDRESS,
      categories: ["data_purchase"],
      perPaymentCap: QUERY_PRICE,
      sellers: [STORE_ADDRESS],
      delegateKey: keyB64(control.publicKey),
      ownerKeyId: "customer-owner-1",
      ownerKey: keyB64(owner.publicKey),
      mandateId: CUSTOMER_MANDATE,
      notAfter: DEMO_EXPIRY,
    },
    owner.privateKey,
  );
  const passAt = (nonce: string, when: Date, proposalHash: string) =>
    encodePass(
      issuePass(
        grant,
        {
          grantId: grant.grantId,
          nonce,
          url: STORE_QUERY_URL,
          payTo: STORE_ADDRESS,
          amount: QUERY_PRICE,
          category: "data_purchase",
          proposalHash,
          at: when.toISOString(),
        },
        control.privateKey,
      ),
    );
  return {
    /** The pass the store kept with a stored order. */
    forOrder: (orderId: string) => passAt(`nonce_${orderId}`, at, canonicalHash({ orderId })),
    /** A new purchase's pass, signed now by the customer's control. */
    fresh: (n: number, when: Date) =>
      passAt(`nonce_buy_${n}`, when, canonicalHash({ purchase: n })),
  };
}

/** The Metal mandate the customer's agent pays under (mock): named in the customer's grant. */
const CUSTOMER_MANDATE = "0x" + createHash("sha256").update("mandate_customer").digest("hex");

/**
 * The store's door in mock mode: a buyer asks for a forecast and the store checks their warrant
 * pass with the same checker our real store runs (control's `PassChecker`). With a pass, it is the
 * customer's agent buying under its owner's grant; without one, a buyer no owner authorized.
 */
function storeDoor(
  passes: ReturnType<typeof customerPasses>,
  clock: () => Date,
): (withPass: boolean) => PassCheckedEvent {
  let event: PassCheckedEvent | undefined;
  const checker = new PassChecker({
    payTo: STORE_ADDRESS,
    category: "data_purchase",
    clock,
    onCheck: (e) => (event = e),
  });
  let n = 0;
  return (withPass) => {
    const header = withPass ? passes.fresh(++n, clock()) : undefined;
    checker.check(header, STORE_QUERY_URL, QUERY_PRICE.cents);
    if (!event) throw new Error("the pass checker reported nothing");
    return event;
  };
}

function order(orderId: string, at: Date, passFor: (orderId: string) => string): SignedOrderRecord {
  const h = createHash("sha256").update(orderId).digest("hex");
  const batch = ORDER_BATCHES[orderId];
  return {
    orderId,
    resource: "GET /query/fx-eurusd",
    price: QUERY_PRICE,
    payee: STORE_ADDRESS,
    payer: CUSTOMER_ADDRESS,
    network: "eip155:63825",
    txHash: "0x" + h,
    settlementId: `stl_${orderId}`,
    signedOffer: "{}",
    deliveredSha256: h,
    ...(batch ? { upstreamBatchId: batch } : {}),
    buyerPass: passFor(orderId),
    at: at.toISOString(),
  };
}

/** A rail that always settles. Records every instruction so the analyzer can show it. */
export class AlwaysPaysRail implements RailAdapter {
  readonly paid: RailInstruction[] = [];
  constructor(readonly rail: Rail) {}
  execute(i: RailInstruction): Promise<RailResult> {
    this.paid.push(i);
    return Promise.resolve({ status: "succeeded", railRef: `mock_${i.idempotencyKey}` });
  }
  getStatus(key: string): Promise<RailResult> {
    return Promise.resolve({ status: "succeeded", railRef: `mock_${key}` });
  }
}

/**
 * Placeholder purpose check until lane A's model lands in `packages/control/purpose`: a price that
 * went up, or a recurring payment, is "uncertain" (goes to the owner); everything else is
 * "consistent". Replace it by passing your own `PurposeChecker` to `createEngine`.
 */
export const placeholderPurpose: PurposeChecker = {
  model: "placeholder (rule of thumb)",
  check: (_w: Warrant, s: PaymentSummary, now: Date): Promise<PurposeVerdict> => {
    const rose = s.priceChangeBps !== null && s.priceChangeBps > 0;
    const unsure = rose || s.recurrence === "recurring";
    return Promise.resolve({
      proposalId: s.proposalId,
      verdict: unsure ? "uncertain" : "consistent",
      reasons: [
        rose
          ? "unexpected_price_change"
          : s.recurrence === "recurring"
            ? "unexpected_recurrence"
            : "matches_warrant_purpose",
      ],
      explanation: "placeholder purpose check",
      model: "placeholder (rule of thumb)",
      evaluatedAt: now.toISOString(),
    });
  },
};

/** The upstream provider as the scenes drive it. */
export interface UpstreamSeller {
  url: string;
  payTo: string;
  price(): number;
  setPrice(cents: number): void;
}

export interface World {
  mode: "mock" | "sandbox";
  ownerPublicKey: KeyObject;
  /** Current mandate credential file per Metal agent; a limit change swaps it. */
  credentials: Map<AgentRole, string>;
  /** The owner's side of a budget change: replace the mandate, sign the next warrant version. */
  applyBudgetChange: (warrant: Warrant, change: BudgetChangeProposal) => Promise<Warrant>;
  /** ADR-009 #1: USDZ budgets across agents stay within TOTAL_BUDGET. */
  budgetCheck: (warrant: Warrant, change: BudgetChangeProposal) => string[];
  warrants: Map<string, Warrant>;
  /** Stored signed orders: three made-up ones in mock mode, our store's real ones in sandbox. */
  orders: () => ReadonlyMap<string, SignedOrderRecord>;
  /** Upstream batches known to be bad (the store refunds what it sold from them). */
  badBatches: ReadonlySet<string>;
  /**
   * The order's settlement is on chain as recorded. Mock: the order's tx is one the world sold.
   * Sandbox: metal-pay's `verifyMandatePayment` over the order's tx and signed order.
   */
  verifySettlement?: (order: SignedOrderRecord) => Promise<{ ok: boolean; detail: string }>;
  /**
   * Sandbox: subscribe to our store's events (each warrant pass check, `pass_checked`). The mock
   * world runs no store.
   */
  watch?: (listener: (e: ControlEvent) => void) => void;
  /**
   * Mock mode only: a buyer asks our store for a forecast and the store checks their warrant pass
   * (with a pass: the customer's agent under its owner's grant; without: nobody authorized it).
   */
  storeSale?: (withPass: boolean) => PassCheckedEvent;
  /** Mock mode only: the in-memory chain behind `GET /chain`. */
  chain?: MockMetalChain;
  upstream: UpstreamSeller;
  /**
   * `metal-agent pay` to the upstream provider with this credential, around control (benchmark
   * "limits only"): only the mandate on chain can refuse it.
   */
  payAround: (credential: string) => Promise<CliResult>;
  /** Settlement transaction of every Metal payment since startup, oldest first. */
  settled: () => readonly string[];
  /** Owner side of the kill switch: revoke every live mandate; answers the credentials revoked. */
  revokeMandates: () => Promise<string[]>;
  rails: {
    metal_x402: MetalAdapter;
    airwallex_transfer: RailAdapter;
    airwallex_card?: RailAdapter;
  };
  /** Lane B's half of the kill switch: freeze every card the warrants use. Set with a card rail. */
  freezeCards?: () => Promise<{ frozenCardIds: string[] }>;
  /**
   * Owner side: move the store's earnings off Metal to our treasury address (`mandate pull`).
   * Answers the settlement tx, the reference for the Airwallex deposit. Mock mode only for now.
   */
  sweepEarnings?: () => Promise<{ tx: string; amount: Money }>;
}

export interface WorldOptions {
  /** Pay `airwallex_transfer` through this rail (the Airwallex adapter) to this beneficiary. */
  airwallex?: { transfers: RailAdapter; licensorRef: string };
  /** Add treasury's card warrant, paid through this card rail (the Airwallex card adapter). */
  card?: RailAdapter & CardControls;
}

/**
 * The owner's side of a budget change, the same in both modes: `replaceMandate` swaps a Metal
 * warrant's mandate, then the next warrant version is signed with the new limits.
 */
export function ownerSigner(
  privateKey: KeyObject,
  warrants: Map<string, Warrant>,
  replaceMandate: (w: Warrant, cap: Money, budget: Money) => Promise<MandateRef>,
): (warrant: Warrant, change: BudgetChangeProposal) => Promise<Warrant> {
  return async (w, c) => {
    const cap = c.newPerPaymentCap ?? w.perPaymentCap;
    const mandate = w.mandate ? await replaceMandate(w, cap, c.newTotalBudget) : undefined;
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    const { signature, status, ...body } = w;
    const signed = signWarrant(
      {
        ...body,
        version: w.version + 1,
        perPaymentCap: cap,
        totalBudget: c.newTotalBudget,
        ...(mandate ? { mandate } : {}),
      },
      privateKey,
      "owner-demo",
    );
    warrants.set(w.warrantId, signed);
    return signed;
  };
}

/** ADR-009 #1: USDZ budgets across agents stay within TOTAL_BUDGET. */
export function totalBudgetCheck(
  warrants: Map<string, Warrant>,
): (warrant: Warrant, change: BudgetChangeProposal) => string[] {
  return (w, c) => {
    if (c.newTotalBudget.currency !== TOTAL_BUDGET.currency) return [];
    const others = [...warrants.values()]
      .filter(
        (x) => x.warrantId !== w.warrantId && x.totalBudget.currency === TOTAL_BUDGET.currency,
      )
      .reduce((sum, x) => sum + x.totalBudget.cents, 0);
    const total = others + c.newTotalBudget.cents;
    return total > TOTAL_BUDGET.cents
      ? [`all agents together would have ${total} cents, over the ${TOTAL_BUDGET.cents} total`]
      : [];
  };
}

/**
 * Wraps a CLI runner to note the settlement transaction of every `pay` and `mandate pull` (a
 * refund) that settled, as the mock chain does. A pull re-run with the same payment id answers
 * the same transaction; it is noted once.
 */
export function recordingRunner(run: CliRunner, settled: string[]): CliRunner {
  return async (args, timeoutMs) => {
    const r = await run(args, timeoutMs);
    const pull = args[0] === "mandate" && args[1] === "pull";
    if (args[0] === "pay" || pull) {
      const o = pull ? classifyPull(r) : classifyPay(r);
      if (o.kind === "paid" && o.tx && !settled.includes(o.tx)) settled.push(o.tx);
    }
    return r;
  };
}

export function makeWorld(now = new Date(), opts: WorldOptions = {}): World {
  const { card } = opts;
  const { privateKey, publicKey } = generateKeyPairSync("ed25519");
  const warrants = new Map(
    bodies(now, demoTerms(), opts.airwallex?.licensorRef, card !== undefined).map((b) => [
      b.warrantId,
      signWarrant(b, privateKey, "owner-demo"),
    ]),
  );
  const passes = customerPasses(now);
  const orders = new Map(
    ["ord_1", "ord_2", "ord_3"].map((id) => [id, order(id, now, passes.forOrder)]),
  );
  const sold = new Set([...orders.values()].map((o) => o.txHash));

  // One mandate per Metal agent, same limits as its warrant (ADR-009 #2).
  const chain = new MockMetalChain();
  chain.fund(PRINCIPAL, 2000);
  const upstream = addUpstream(chain, 2);
  const expires = new Date(DEMO_EXPIRY);
  chain.addMandate({
    credential: "sourcing.json",
    principal: PRINCIPAL,
    capCents: AGENT_BUDGETS.sourcing.perPaymentCap.cents,
    budgetCents: AGENT_BUDGETS.sourcing.budget.cents,
    payees: [UPSTREAM_PAY_TO],
    expiresAt: expires,
  });
  chain.addMandate({
    credential: "support.json",
    principal: PRINCIPAL,
    capCents: AGENT_BUDGETS.support.perPaymentCap.cents,
    budgetCents: AGENT_BUDGETS.support.budget.cents,
    expiresAt: expires,
  });

  // ADR-022: treasury's sweep mandate pays from the store's account, only to our treasury
  // address. The store's account holds what the stored orders earned.
  const earned = [...orders.values()].reduce((n, o) => n + o.price.cents, 0);
  chain.fund(STORE_ADDRESS, earned);
  chain.addMandate({
    credential: "treasury-sweep.json",
    principal: STORE_ADDRESS,
    capCents: AGENT_BUDGETS.treasury.perPaymentCap.cents,
    budgetCents: AGENT_BUDGETS.treasury.budget.cents,
    payees: [TREASURY_ADDRESS],
    expiresAt: expires,
  });

  // One credential per role: treasury's only Metal warrant is the sweep.
  const credentials = new Map<AgentRole, string>([
    ["sourcing", "sourcing.json"],
    ["support", "support.json"],
    ["treasury", "treasury-sweep.json"],
  ]);

  const applyBudgetChange = ownerSigner(privateKey, warrants, (w, cap, budget) => {
    const old = credentials.get(w.agentRole);
    if (!old || !w.mandate) throw new Error(`no mandate credential for ${w.agentRole}`);
    const next = `${w.agentRole}-v${w.version + 1}.json`;
    const m = chain.replaceMandate(old, {
      credential: next,
      principal: chain.mandate(old).principal,
      capCents: cap.cents,
      budgetCents: budget.cents,
      ...(chain.mandate(old).payees ? { payees: chain.mandate(old).payees } : {}),
      expiresAt: expires,
    });
    credentials.set(w.agentRole, next);
    return Promise.resolve({ ...w.mandate, mandateId: m.mandateId, cap, budget });
  });

  return {
    mode: "mock",
    storeSale: storeDoor(passes, () => new Date()),
    ownerPublicKey: publicKey,
    credentials,
    applyBudgetChange,
    budgetCheck: totalBudgetCheck(warrants),
    warrants,
    orders: () => orders,
    badBatches: new Set([BAD_BATCH]),
    verifySettlement: (o) =>
      Promise.resolve(
        sold.has(o.txHash)
          ? { ok: true, detail: `settlement ${o.txHash.slice(0, 10)}... is on chain as recorded` }
          : { ok: false, detail: "no settlement on chain matches this order" },
      ),
    chain,
    upstream,
    payAround: (cred) => chain.runner()(["pay", UPSTREAM_URL, "--mandate", cred], 60_000),
    settled: () => chain.txs.map((t) => t.hash),
    revokeMandates: () => {
      const live = chain.mandateList().filter((m) => !m.revoked);
      for (const m of live) chain.revokeMandate(m.credential);
      return Promise.resolve(live.map((m) => m.credential));
    },
    rails: {
      // The real adapter and its real output parsers, talking to the mock chain.
      metal_x402: new MetalAdapter({
        run: chain.runner(),
        metalHome: "mock-metal-home",
        rpcUrl: "mock",
        quote: (url) => Promise.resolve(url === UPSTREAM_URL ? upstream.price() : undefined),
        // The facilitator's /settlements lookup: settles a pay whose answer was lost (ADR-019).
        lookupSettlement: (_url, nonce) => {
          const tx = chain.settlementByNonce(nonce);
          return Promise.resolve(
            tx ? { status: "succeeded", railRef: tx.hash, detail: "paid" } : undefined,
          );
        },
      }),
      airwallex_transfer: opts.airwallex?.transfers ?? new AlwaysPaysRail("airwallex_transfer"),
      ...(card ? { airwallex_card: card } : {}),
    },
    ...(card ? { freezeCards: () => card.freezeAll() } : {}),
    sweepEarnings: async () => {
      // What the store took on chain moves to our treasury address under the store's own mandate.
      const cents = [...orders.values()].reduce((n, o) => n + o.price.cents, 0);
      if (!chain.mandateList().some((m) => m.credential === "store-sweep.json")) {
        chain.fund(STORE_ADDRESS, cents);
        chain.addMandate({
          credential: "store-sweep.json",
          principal: STORE_ADDRESS,
          capCents: cents,
          budgetCents: cents,
          payees: [TREASURY_ADDRESS],
          expiresAt: expires,
        });
      }
      const pull = classifyPull(
        await chain.runner()(
          [
            "mandate",
            "pull",
            "--credential",
            "store-sweep.json",
            "--to",
            TREASURY_ADDRESS,
            "--amount",
            `${Math.floor(cents / 100)}.${String(cents % 100).padStart(2, "0")}`,
            "--payment-id",
            "sweep-1",
          ],
          60_000,
        ),
      );
      if (pull.kind !== "paid" || !pull.tx) throw new Error(`sweep did not settle: ${pull.kind}`);
      return { tx: pull.tx, amount: { currency: "USDZ", cents } };
    },
  };
}
