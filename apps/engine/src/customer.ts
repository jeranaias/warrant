import { generateKeyPairSync } from "node:crypto";
import type { Money, WarrantBody } from "@warrant/contracts";
import {
  Controller,
  QUERY_PRICE,
  issueGrant,
  keyB64,
  passIssuer,
  signWarrant,
} from "@warrant/control";
import { CliMetalOwnerOps, MetalAdapter, x402Quote } from "@warrant/rails";
import type { CliRunner } from "@warrant/rails";
import { CATALOG } from "@warrant/store";
import type { CustomerConfig, LiveConfig } from "./config.js";
import { placeholderPurpose } from "./world.js";

/**
 * The simulated customer on Metal testnet: another business whose own owner signed a warrant for
 * its buying agent, on the customer's own mandate (`customer-agent.json`, 5-cent cap, our store
 * its only payee). Its purchases go through its own control, the same Controller we use: rules,
 * then `metal-agent pay` with the customer's mandate, a signed order (the store asks for one) and
 * a warrant pass signed under the customer owner's grant.
 *
 * Our engine never holds this customer's keys in the story; here they are fresh per run and stay
 * in this process. The mandate credential stays in METAL_HOME.
 */

export interface CustomerBuyer {
  /** The customer's smart account (the payer our store sees). */
  address: string;
  /** The customer's mandate id on chain; its grant names it. */
  mandateId: string;
  /** Buys one catalog item from our store. `tx` is the settlement when it paid. */
  buy(itemId: string): Promise<{ outcome: string; tx?: string }>;
}

const usdz = (cents: number): Money => ({ currency: "USDZ", cents });

export async function makeLiveCustomer(o: {
  cfg: LiveConfig;
  customer: CustomerConfig;
  run: CliRunner;
  clock?: () => Date;
}): Promise<CustomerBuyer> {
  const { cfg, customer, run } = o;
  const clock = o.clock ?? (() => new Date());
  const status = await new CliMetalOwnerOps({
    run,
    metalHome: cfg.home,
    rpcUrl: cfg.rpcUrl,
    // Read-only here (`mandate status`): no owner operation runs on the customer's mandate.
    ownerKey: "customer-owner.json",
    principal: customer.address,
  }).status(customer.credential);
  if (status.revoked || !status.bound) {
    throw new Error(
      `the customer's mandate (${customer.credential}) is ${status.revoked ? "revoked" : "not bound"} ` +
        `on chain; see "Running live" in docs/TESTNET.md`,
    );
  }
  if (status.capCents < QUERY_PRICE.cents) {
    throw new Error(
      `the customer's mandate cap is ${status.capCents} cents, under our ${QUERY_PRICE.cents}-cent price`,
    );
  }

  const storeOrigin = `http://127.0.0.1:${cfg.storePort}`;
  const owner = generateKeyPairSync("ed25519");
  const control = generateKeyPairSync("ed25519");
  const now = clock();
  const cap = usdz(status.capCents);
  const body: WarrantBody = {
    warrantId: "wrt_customer",
    version: 1,
    ownerId: "own_customer",
    agentId: "agt_customer",
    // The customer's buying agent: it buys data, as our sourcing agent does upstream.
    agentRole: "sourcing",
    purpose: "Buy market data queries from the Warrant store for our analysts.",
    allowedRails: ["metal_x402"],
    payees: CATALOG.map((it) => ({
      payeeId: `store_${it.id}`,
      displayName: it.title,
      rail: "metal_x402" as const,
      routingRef: `${storeOrigin}${it.path}`,
      currency: "USDZ" as const,
    })),
    perPaymentCap: cap,
    totalBudget: usdz(status.budgetCents),
    notBefore: new Date(now.getTime() - 60_000).toISOString(),
    expiresAt: status.expiresAt,
    mandate: {
      network: "eip155:63825",
      mandateId: status.mandateId,
      principal: customer.address,
      cap,
      budget: usdz(status.budgetCents),
      expiresAt: status.expiresAt,
    },
  };
  const warrant = signWarrant(body, owner.privateKey, "customer-owner");
  const grant = issueGrant(
    {
      grantId: "grt_customer",
      warrantId: warrant.warrantId,
      warrantVersion: warrant.version,
      ownerId: warrant.ownerId,
      payer: customer.address,
      mandateId: status.mandateId,
      categories: ["data_purchase"],
      perPaymentCap: cap,
      sellers: [cfg.business],
      delegateKey: keyB64(control.publicKey),
      ownerKeyId: "customer-owner-1",
      ownerKey: keyB64(owner.publicKey),
      notAfter: status.expiresAt,
    },
    owner.privateKey,
  );

  const controller = new Controller({
    ownerPublicKey: owner.publicKey,
    getWarrant: (id) => (id === warrant.warrantId ? warrant : undefined),
    rails: {
      metal_x402: new MetalAdapter({
        run,
        metalHome: cfg.home,
        rpcUrl: cfg.rpcUrl,
        quote: x402Quote(),
      }),
    },
    purpose: placeholderPurpose,
    credentialFor: () => customer.credential,
    passFor: passIssuer({
      grant,
      delegateKey: control.privateKey,
      payToFor: (url) => (url.startsWith(`${storeOrigin}/`) ? cfg.business : undefined),
      clock,
    }),
    clock,
  });

  let n = 0;
  return {
    address: customer.address,
    mandateId: status.mandateId,
    buy: async (itemId) => {
      const k = ++n;
      const r = await controller.submit({
        proposalId: `prop_customer_${k}`,
        warrantId: warrant.warrantId,
        agentId: warrant.agentId,
        agentRole: "sourcing",
        rail: "metal_x402",
        payeeId: `store_${itemId}`,
        amount: QUERY_PRICE,
        category: "data_purchase",
        recurrence: "one_off",
        idempotencyKey: `customer-${clock().getTime()}-${k}`,
        justification: "analyst asked for this series",
        createdAt: clock().toISOString(),
      });
      const ex = r.execution;
      if (ex?.status === "succeeded" && ex.railRef) return { outcome: "paid", tx: ex.railRef };
      const why = ex?.detail ?? r.error ?? r.blockedBy ?? "not paid";
      if (r.approval) return { outcome: "waiting for the customer's owner" };
      return { outcome: ex ? `${ex.status}: ${why}` : why };
    },
  };
}
