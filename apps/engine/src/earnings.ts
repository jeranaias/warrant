import { startAirwallexMock } from "@warrant/mocks/airwallex";
import {
  AirwallexClient,
  AirwallexTransfers,
  createEurBeneficiary,
  depositEarnings,
  simulateTransfer,
  transferStatus,
} from "@warrant/rails";
import type { PaymentProposal } from "@warrant/contracts";
import type { SceneStep } from "./scenes.js";
import { createEngine } from "./server.js";
import type { Engine } from "./server.js";
import { AGENTS, makeWorld } from "./world.js";
import type { World } from "./world.js";

/** The fx rate the mock quotes: 1 EUR = 1.122579 USD (a real sandbox quote, 2026-10-30). */
const EURUSD = "1.122579";
/** Cash already in the business's Airwallex wallet before today's earnings land (USD). */
const OPENING_USD = 60;
/** The licensor's IBAN: a sandbox-accepted example (see packages/mocks/README.md). */
const LICENSOR_IBAN = "ES9121000418450200051332";

export interface AirwallexWorld {
  world: World;
  client: AirwallexClient;
  close: () => Promise<void>;
}

/**
 * A mock world whose `airwallex_transfer` rail is the real Airwallex adapter talking to the
 * Airwallex mock: the licensor is a real EUR beneficiary there, and the wallet starts with USD.
 */
export async function mockAirwallexWorld(now = new Date()): Promise<AirwallexWorld> {
  const awx = await startAirwallexMock({
    balances: { USD: OPENING_USD },
    rates: { EURUSD },
  });
  // The mock accepts any client id and key; nothing here is a real credential.
  const client = new AirwallexClient({ baseUrl: awx.url, clientId: "mock", apiKey: "mock" });
  const licensorRef = await createEurBeneficiary(client, {
    name: "Data Licensor GmbH",
    iban: LICENSOR_IBAN,
    address: {
      street: "Calle Mayor 1",
      city: "Madrid",
      state: "Madrid",
      postcode: "28013",
      country: "ES",
    },
  });
  const transfers = new AirwallexTransfers(client, { fundingCurrency: "USD" });
  const world = makeWorld(now, { airwallex: { transfers, licensorRef } });
  return { world, client, close: () => awx.close() };
}

const ORDER = ["SCHEDULED", "PROCESSING", "SENT", "PAID"] as const;

/**
 * Kit 11 + Kit 2 beat (DEMO.md beat 6): both rails, one ledger.
 *   1. the store's earnings move off Metal to our treasury address (`mandate pull`)
 *   2. they land in Airwallex as a deposit referenced by that transaction hash
 *   3. treasury pays the EUR 50 licence fee: control approves (payee on the warrant), the adapter
 *      converts USD to EUR because the wallet has no euros, then sends a LOCAL transfer
 *   4. the bank moves it to PAID; control's ledger confirms it on the next reconcile
 */
export async function earningsScene(
  now = () => new Date(),
  awx?: AirwallexWorld,
): Promise<SceneStep[]> {
  const own = awx ?? (await mockAirwallexWorld(now()));
  const engine: Engine = createEngine({ scenario: "none", clock: now, world: own.world });
  const { controller, world } = engine;
  const steps: SceneStep[] = [];
  try {
    if (!world.sweepEarnings) throw new Error("this world cannot sweep earnings yet");
    const swept = await world.sweepEarnings();
    steps.push({
      step: "store earnings off Metal (mandate pull)",
      outcome: `${swept.amount.cents}c to our treasury address`,
      moneyMoved: true,
      tx: swept.tx,
    });

    const dep = await depositEarnings(own.client, {
      amount: { currency: "USD", cents: swept.amount.cents },
      metalTx: swept.tx,
    });
    steps.push({
      step: "deposit into Airwallex",
      outcome: `${dep.amount.cents}c USD, reference = the Metal tx`,
      moneyMoved: true,
    });

    const fee: PaymentProposal = {
      proposalId: "prop_licence_fee",
      warrantId: AGENTS.treasury.warrantId,
      agentId: AGENTS.treasury.agentId,
      agentRole: "treasury",
      rail: "airwallex_transfer",
      payeeId: "pay_licensor",
      amount: { currency: "EUR", cents: 5000 },
      category: "licence_fee",
      recurrence: "one_off",
      idempotencyKey: "scene-licence-fee-1",
      justification: "Invoice INV-1107: monthly data licence",
      createdAt: now().toISOString(),
    };
    const r = await controller.submit(fee);
    const transferId = r.execution?.railRef;
    steps.push({
      step: "treasury pays the EUR 50 licence fee",
      outcome: r.execution
        ? `${r.execution.status} (${r.execution.detail ?? ""}): USD converted to EUR, transfer sent`
        : (r.blockedBy ?? r.error ?? "?"),
      moneyMoved: r.execution?.status === "pending" || r.execution?.status === "succeeded",
    });
    if (!transferId) return steps;

    // The sandbox (and the mock) only move a transfer along when asked to.
    for (;;) {
      const s = await world.rails.airwallex_transfer.getStatus(fee.idempotencyKey);
      const at = ORDER.indexOf((s.detail ?? "") as (typeof ORDER)[number]);
      const next = ORDER[at + 1];
      if (at < 0 || !next || next === "SCHEDULED") break;
      await simulateTransfer(own.client, transferId, next);
    }
    const rec = await controller.reconcile();
    const last = transferStatus(
      (await own.client.call("GET", `/api/v1/transfers?request_id=${fee.idempotencyKey}`)).body
        ?.items?.[0],
    );
    steps.push({
      step: "the bank pays it out",
      outcome: `${last.detail ?? last.status}; ledger ${rec.confirmed.length ? "confirmed" : "still waiting"}`,
      moneyMoved: false,
    });
    return steps;
  } finally {
    if (!awx) await own.close();
  }
}
