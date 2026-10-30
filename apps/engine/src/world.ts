import { createHash, generateKeyPairSync } from "node:crypto";
import type { KeyObject } from "node:crypto";
import type {
  AgentRole,
  BudgetChangeProposal,
  Money,
  PaymentSummary,
  PurposeVerdict,
  SignedOrderRecord,
  Warrant,
  WarrantBody,
} from "@warrant/contracts";
import { AGENT_BUDGETS, QUERY_PRICE, TOTAL_BUDGET, signWarrant } from "@warrant/control";
import type { PurposeChecker } from "@warrant/control";
import { MetalAdapter } from "@warrant/rails";
import type { RailAdapter, RailInstruction, RailResult } from "@warrant/rails";
import type { Rail } from "@warrant/contracts";
import { MockMetalChain, UPSTREAM_PAY_TO, UPSTREAM_URL, addUpstream } from "@warrant/mocks/metal";
import type { Upstream } from "@warrant/mocks/metal";

/**
 * The engine's pretend world: an owner, three signed warrants, two stored orders, a mock Metal
 * chain that enforces each agent's mandate (with the upstream provider selling on it) and an
 * Airwallex rail that always succeeds. Everything is in memory and made fresh at startup. Nothing here touches a real
 * key, account or network.
 */

const eur = (cents: number): Money => ({ currency: "EUR", cents });
const addr = (c: string) => "0x" + c.repeat(40);

export const OWNER_ID = "own_demo";
export const CUSTOMER_ADDRESS = addr("c");
const STORE_ADDRESS = addr("5");
const PRINCIPAL = addr("a");

export interface AgentIdentity {
  role: AgentRole;
  agentId: string;
  warrantId: string;
}

export const AGENTS: Record<AgentRole, AgentIdentity> = {
  sourcing: { role: "sourcing", agentId: "agt_sourcing", warrantId: "wrt_sourcing" },
  support: { role: "support", agentId: "agt_support", warrantId: "wrt_support" },
  treasury: { role: "treasury", agentId: "agt_treasury", warrantId: "wrt_treasury" },
};

function bodies(now: Date): WarrantBody[] {
  const notBefore = new Date(now.getTime() - 60_000).toISOString();
  const expiresAt = "2026-11-20T00:00:00Z";
  const mandate = (cap: Money, budget: Money) => ({
    network: "eip155:63825" as const,
    mandateId: "mnd_demo",
    principal: PRINCIPAL,
    cap,
    budget,
    expiresAt,
  });
  const common = { version: 1, ownerId: OWNER_ID, notBefore, expiresAt };
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
          routingRef: UPSTREAM_URL,
          currency: "USDZ",
        },
      ],
      perPaymentCap: AGENT_BUDGETS.sourcing.perPaymentCap,
      totalBudget: AGENT_BUDGETS.sourcing.budget,
      mandate: mandate(AGENT_BUDGETS.sourcing.perPaymentCap, AGENT_BUDGETS.sourcing.budget),
    },
    {
      ...common,
      agentId: AGENTS.support.agentId,
      warrantId: AGENTS.support.warrantId,
      agentRole: "support",
      purpose: "Refund customers for orders we got wrong, never more than they paid.",
      allowedRails: ["metal_x402"],
      payees: [],
      perPaymentCap: AGENT_BUDGETS.support.perPaymentCap,
      totalBudget: AGENT_BUDGETS.support.budget,
      mandate: mandate(AGENT_BUDGETS.support.perPaymentCap, AGENT_BUDGETS.support.budget),
    },
    {
      // The engine's treasury pays the EUR licence fee only. Earnings sweeps come with lane B.
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
          routingRef: "ben_licensor",
          currency: "EUR",
        },
      ],
      perPaymentCap: eur(5000),
      totalBudget: eur(10000),
    },
  ];
}

function order(orderId: string, at: Date): SignedOrderRecord {
  const h = createHash("sha256").update(orderId).digest("hex");
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

export interface World {
  ownerPublicKey: KeyObject;
  /** Current mandate credential file per Metal agent; a limit change swaps it. */
  credentials: Map<AgentRole, string>;
  /** The owner's side of a budget change: replace the mandate, sign the next warrant version. */
  applyBudgetChange: (warrant: Warrant, change: BudgetChangeProposal) => Promise<Warrant>;
  /** ADR-009 #1: USDZ budgets across agents stay within TOTAL_BUDGET. */
  budgetCheck: (warrant: Warrant, change: BudgetChangeProposal) => string[];
  warrants: Map<string, Warrant>;
  orders: Map<string, SignedOrderRecord>;
  chain: MockMetalChain;
  upstream: Upstream;
  rails: { metal_x402: MetalAdapter; airwallex_transfer: AlwaysPaysRail };
}

export function makeWorld(now = new Date()): World {
  const { privateKey, publicKey } = generateKeyPairSync("ed25519");
  const warrants = new Map(
    bodies(now).map((b) => [b.warrantId, signWarrant(b, privateKey, "owner-demo")]),
  );
  const orders = new Map(["ord_1", "ord_2", "ord_3"].map((id) => [id, order(id, now)]));

  // One mandate per Metal agent, same limits as its warrant (ADR-009 #2).
  const chain = new MockMetalChain();
  chain.fund(PRINCIPAL, 2000);
  const upstream = addUpstream(chain, 2);
  const expires = new Date("2026-11-20T00:00:00Z");
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

  const credentials = new Map<AgentRole, string>([
    ["sourcing", "sourcing.json"],
    ["support", "support.json"],
  ]);

  const applyBudgetChange = (w: Warrant, c: BudgetChangeProposal): Promise<Warrant> => {
    const cap = c.newPerPaymentCap ?? w.perPaymentCap;
    let mandate = w.mandate;
    if (mandate) {
      const old = credentials.get(w.agentRole);
      if (!old) throw new Error(`no mandate credential for ${w.agentRole}`);
      const next = `${w.agentRole}-v${w.version + 1}.json`;
      const m = chain.replaceMandate(old, {
        credential: next,
        principal: PRINCIPAL,
        capCents: cap.cents,
        budgetCents: c.newTotalBudget.cents,
        ...(chain.mandate(old).payees ? { payees: chain.mandate(old).payees } : {}),
        expiresAt: expires,
      });
      credentials.set(w.agentRole, next);
      mandate = { ...mandate, mandateId: m.mandateId, cap, budget: c.newTotalBudget };
    }
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
    return Promise.resolve(signed);
  };

  const budgetCheck = (w: Warrant, c: BudgetChangeProposal): string[] => {
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

  return {
    ownerPublicKey: publicKey,
    credentials,
    applyBudgetChange,
    budgetCheck,
    warrants,
    orders,
    chain,
    upstream,
    rails: {
      // The real adapter and its real output parsers, talking to the mock chain.
      metal_x402: new MetalAdapter({
        run: chain.runner(),
        metalHome: "mock-metal-home",
        rpcUrl: "mock",
        quote: (url) => Promise.resolve(url === UPSTREAM_URL ? upstream.price() : undefined),
      }),
      airwallex_transfer: new AlwaysPaysRail("airwallex_transfer"),
    },
  };
}
