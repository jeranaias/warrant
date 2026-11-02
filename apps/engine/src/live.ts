import { generateKeyPairSync } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import type { Server } from "node:http";
import { join } from "node:path";
import express from "express";
import { HTTPFacilitatorClient, x402ResourceServer } from "@x402/core/server";
import { paymentMiddleware } from "@x402/express";
import { METAL_NETWORKS, registerMetalScheme } from "@metalntwx/metal-pay";
import { requireSignedOffer } from "@metalntwx/metal-pay/mandates";
import type { AgentRole, MandateRef, Warrant } from "@warrant/contracts";
import { AGENT_BUDGETS, PassChecker, UPSTREAM_PRICE_BEFORE, signWarrant } from "@warrant/control";
import type { ControlEvent } from "@warrant/control";
import { CliMetalOwnerOps, MetalAdapter, execCliRunner, x402Quote } from "@warrant/rails";
import type { MandateStatus } from "@warrant/rails";
import {
  METAL_TESTNET,
  OrderStore,
  chainVerifier,
  createStoreApp,
  dollars,
  sampleInventory,
  settlementVerifier,
} from "@warrant/store";
import type { CustomerConfig, LiveConfig } from "./config.js";
import { makeLiveCustomer } from "./customer.js";
import type { CustomerBuyer } from "./customer.js";
import {
  AGENTS,
  AlwaysPaysRail,
  METAL_ROLES,
  bodies,
  ownerSigner,
  recordingRunner,
  totalBudgetCheck,
} from "./world.js";
import type { MetalRole, MetalTerms, UpstreamSeller, World } from "./world.js";

/**
 * RAILS_MODE=sandbox: the engine's World on the real Metal testnet. Same warrants, controller and
 * scenes as mock mode; what changes:
 *
 * - metal_x402 runs the real `metal-agent` 0.3.3 with the owner's credentials in METAL_HOME.
 * - Each warrant is signed from what the chain says about its mandate (`mandate status`), so the
 *   warrant never claims more than the mandate allows (ADR-009 #2).
 * - The upstream provider is a real x402 seller on UPSTREAM_PORT, paid to its testnet account;
 *   our store runs on STORE_PORT and stores real signed orders.
 * - A budget change the owner approves runs `mandate replace` on chain. Which credential is
 *   current is kept in WARRANT_DATA_DIR/owner-state.json (outside the repo), so the next start
 *   uses it; `pnpm reset:live` puts sourcing back on day-one limits.
 * - Disputes check each order's settlement on chain with metal-pay's `verifyMandatePayment`.
 * - Airwallex stays on the in-memory rail: rails has no sandbox Airwallex adapter yet.
 *
 * Never logged or returned: key material, credential contents, the RPC URL.
 */

export interface LiveWorld extends World {
  /** Starts the upstream seller and our store. Close them when done. */
  listen(): Promise<{ close(): Promise<void> }>;
  /** Owner: put sourcing back on day-one limits with a new mandate version (rehearsal reset). */
  resetSourcing(): Promise<string | undefined>;
  /** The store learns an upstream batch was bad: disputes over orders served from it refund. */
  markBatchBad(batchId: string): void;
  /** The simulated customer's buying agent, on its own mandate (the live dispute scene). */
  customer(c: CustomerConfig, clock?: () => Date): Promise<CustomerBuyer>;
}

interface OwnerState {
  credentials: Record<MetalRole, string>;
  versions: Record<MetalRole, number>;
}

const UPSTREAM_PATH = "/forecast/eurusd";

export async function makeLiveWorld(cfg: LiveConfig, now = new Date()): Promise<LiveWorld> {
  mkdirSync(cfg.dataDir, { recursive: true });
  const cli = execCliRunner(cfg.bin, cfg.cliEnv);
  const settled: string[] = [];
  const run = recordingRunner(cli, settled);
  const owner = new CliMetalOwnerOps({
    run: cli,
    metalHome: cfg.home,
    rpcUrl: cfg.rpcUrl,
    ownerKey: cfg.ownerKey,
    principal: cfg.business,
  });

  const state = loadState(cfg);
  const status = {} as Record<MetalRole, MandateStatus>;
  for (const role of METAL_ROLES) {
    const s = await owner.status(state.credentials[role]);
    if (s.revoked || !s.bound) {
      throw new Error(
        `${role} mandate (${state.credentials[role]}) is ${s.revoked ? "revoked" : "not bound"} ` +
          `on chain; see "Running live" in docs/TESTNET.md`,
      );
    }
    status[role] = s;
  }

  const ref = (s: MandateStatus): MandateRef => ({
    network: "eip155:63825",
    mandateId: s.mandateId,
    principal: cfg.business,
    cap: { currency: "USDZ", cents: s.capCents },
    budget: { currency: "USDZ", cents: s.budgetCents },
    expiresAt: s.expiresAt,
  });
  const terms: MetalTerms = {
    upstreamUrl: `http://127.0.0.1:${cfg.upstreamPort}${UPSTREAM_PATH}`,
    mandates: {
      sourcing: { version: state.versions.sourcing, mandate: ref(status.sourcing) },
      support: { version: state.versions.support, mandate: ref(status.support) },
    },
  };

  // A fresh owner signing key per run: warrants are re-signed from the chain at every start.
  const { privateKey, publicKey } = generateKeyPairSync("ed25519");
  const warrants = new Map(
    bodies(now, terms).map((b) => [b.warrantId, signWarrant(b, privateKey, "owner-demo")]),
  );
  const credentials = new Map<AgentRole, string>(METAL_ROLES.map((r) => [r, state.credentials[r]]));

  const applyBudgetChange = ownerSigner(privateKey, warrants, async (w, cap, budget) => {
    const role = metalRole(w);
    const old = state.credentials[role];
    const version = w.version + 1;
    // A new file every time: the CLI never overwrites a credential, and history is kept.
    const next = `${role}-v${version}-${Date.now()}.json`;
    const before = await owner.status(old);
    await owner.replace(old, next, {
      capCents: cap.cents,
      budgetCents: budget.cents,
      payees: before.payees,
      expiresInSeconds: Math.floor((Date.parse(before.expiresAt) - Date.now()) / 1000),
      description: `Warrant ${role} v${version}`,
    });
    const after = await owner.status(next);
    if (!after.bound || after.capCents !== cap.cents || after.budgetCents !== budget.cents) {
      throw new Error("the replaced mandate does not show the approved limits");
    }
    state.credentials[role] = next;
    state.versions[role] = version;
    saveState(cfg, state);
    credentials.set(role, next);
    return ref(after);
  });

  let price = UPSTREAM_PRICE_BEFORE.cents;
  const upstream: UpstreamSeller = {
    url: terms.upstreamUrl,
    payTo: cfg.upstream,
    price: () => price,
    setPrice: (cents) => {
      if (!Number.isInteger(cents) || cents <= 0) throw new Error("price must be whole cents > 0");
      price = cents;
    },
  };
  const orders = new OrderStore(join(cfg.dataDir, "orders.jsonl"));
  const badBatches = new Set<string>();
  const listeners: ((e: ControlEvent) => void)[] = [];
  const told = (e: ControlEvent) => listeners.forEach((f) => f(e));

  const world: LiveWorld = {
    mode: "sandbox",
    ownerPublicKey: publicKey,
    credentials,
    applyBudgetChange,
    budgetCheck: totalBudgetCheck(warrants),
    warrants,
    orders: () => orders.asMap(),
    badBatches,
    verifySettlement: settlementVerifier(chainVerifier(cfg.rpcUrl)),
    upstream,
    payAround: (cred) =>
      run(
        ["pay", upstream.url, "--mandate", join(cfg.home, cred), "--network", "testnet"],
        120_000,
      ),
    settled: () => settled,
    revokeMandates: async () => {
      // One at a time: both are signed by the same owner account.
      const revoked: string[] = [];
      for (const role of METAL_ROLES) {
        await owner.revoke(state.credentials[role]);
        revoked.push(state.credentials[role]);
      }
      return revoked;
    },
    rails: {
      // quote: what the seller's 402 asks right now, so a changed price is refused unsigned.
      metal_x402: new MetalAdapter({
        run,
        metalHome: cfg.home,
        rpcUrl: cfg.rpcUrl,
        quote: x402Quote(),
      }),
      airwallex_transfer: new AlwaysPaysRail("airwallex_transfer"),
    },
    watch: (f) => void listeners.push(f),
    listen: () => listen(cfg, upstream, orders, told),
    markBatchBad: (batchId) => void badBatches.add(batchId),
    customer: (c, clock) =>
      makeLiveCustomer({ cfg, customer: c, run, ...(clock ? { clock } : {}) }),
    resetSourcing: async () => {
      const w = warrants.get(AGENTS.sourcing.warrantId);
      const day1 = AGENT_BUDGETS.sourcing;
      if (!w) throw new Error("no sourcing warrant");
      if (
        w.perPaymentCap.cents === day1.perPaymentCap.cents &&
        w.totalBudget.cents === day1.budget.cents
      ) {
        return undefined;
      }
      await applyBudgetChange(w, {
        proposalId: `bcp_reset_${Date.now()}`,
        warrantId: w.warrantId,
        agentId: AGENTS.treasury.agentId,
        newTotalBudget: day1.budget,
        newPerPaymentCap: day1.perPaymentCap,
        justification: "owner reset for a rehearsal",
        createdAt: new Date().toISOString(),
      });
      return state.credentials.sourcing;
    },
  };
  return world;
}

function metalRole(w: Warrant): MetalRole {
  if (w.agentRole === "sourcing" || w.agentRole === "support") return w.agentRole;
  throw new Error(`${w.agentRole} has no Metal mandate`);
}

function loadState(cfg: LiveConfig): OwnerState {
  const f = join(cfg.dataDir, "owner-state.json");
  if (existsSync(f)) return JSON.parse(readFileSync(f, "utf8")) as OwnerState;
  return { credentials: { ...cfg.credentials }, versions: { sourcing: 1, support: 1 } };
}

function saveState(cfg: LiveConfig, state: OwnerState): void {
  writeFileSync(join(cfg.dataDir, "owner-state.json"), JSON.stringify(state, null, 2) + "\n");
}

/**
 * The two x402 sellers, settled by Metal's facilitator on testnet. Bound to 127.0.0.1.
 * Upstream: the simulated provider, at whatever `upstream.price()` says now. Store: ours, signed
 * order and warrant pass required (apps/store).
 */
async function listen(
  cfg: LiveConfig,
  upstream: UpstreamSeller,
  orders: OrderStore,
  onEvent: (e: ControlEvent) => void,
): Promise<{ close(): Promise<void> }> {
  const facilitator = () =>
    new HTTPFacilitatorClient({
      url: cfg.facilitatorUrl ?? METAL_NETWORKS.testnet.facilitatorUrl,
    });

  const up = express();
  up.disable("x-powered-by");
  let batch = 0;
  up.use(
    paymentMiddleware(
      {
        [`GET ${UPSTREAM_PATH}`]: {
          accepts: {
            scheme: "exact",
            network: METAL_TESTNET,
            payTo: upstream.payTo,
            price: () => dollars(upstream.price()),
          },
          description: "Upstream market data: EUR/USD forecast batch",
        },
      },
      registerMetalScheme(new x402ResourceServer(facilitator()), { networks: ["testnet"] }),
    ),
  );
  up.get(UPSTREAM_PATH, (_req, res) => {
    res.json({ batchId: `ub_${++batch}`, pair: "EURUSD", rate: 1.0842 });
  });

  const store = createStoreApp({
    payTo: cfg.business,
    inventory: sampleInventory(),
    orders,
    x402: requireSignedOffer(
      registerMetalScheme(new x402ResourceServer(facilitator()), { networks: ["testnet"] }),
      { rpcUrl: cfg.rpcUrl },
    ),
    passes: new PassChecker({ payTo: cfg.business, category: "data_purchase", onCheck: onEvent }),
    onError: (msg) => console.error(`[store] ${msg}`),
  });

  const servers = await Promise.all([serve(up, cfg.upstreamPort), serve(store, cfg.storePort)]);
  return {
    close: () =>
      Promise.all(servers.map((s) => new Promise<void>((r) => s.close(() => r())))).then(
        () => undefined,
      ),
  };
}

function serve(app: express.Express, port: number): Promise<Server> {
  return new Promise((resolve, reject) => {
    // Express 5 hands a listen error (e.g. port in use) to this callback.
    const s = app.listen(port, "127.0.0.1", (err?: Error) => (err ? reject(err) : resolve(s)));
  });
}
