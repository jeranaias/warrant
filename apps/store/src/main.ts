import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { HTTPFacilitatorClient, x402ResourceServer } from "@x402/core/server";
import { METAL_NETWORKS, registerMetalScheme } from "@metalntwx/metal-pay";
import { requireSignedOffer } from "@metalntwx/metal-pay/mandates";
import { sampleInventory } from "./catalog.js";
import { OrderStore } from "./orders.js";
import { createStoreApp } from "./server.js";

/**
 * Starts our store. RAILS_MODE=mock serves unpaid (for UI work). RAILS_MODE=sandbox charges real
 * testnet USDZ through Metal's facilitator and requires the buyer's signed order.
 */
const mode = process.env["RAILS_MODE"] ?? "mock";
const port = Number(process.env["STORE_PORT"] ?? 4021);
const payTo = process.env["METAL_STORE_ADDRESS"] ?? "";
const ordersFile = process.env["STORE_ORDERS_FILE"] ?? "data/orders.jsonl";

mkdirSync(dirname(ordersFile), { recursive: true });
const orders = new OrderStore(ordersFile);
const inventory = sampleInventory();

let x402: x402ResourceServer | undefined;
if (mode !== "mock") {
  const rpcUrl = process.env["METAL_RPC_URL"];
  if (!payTo || !rpcUrl) {
    throw new Error("set METAL_STORE_ADDRESS and METAL_RPC_URL in .env (or RAILS_MODE=mock)");
  }
  const facilitator = new HTTPFacilitatorClient({
    url: process.env["METAL_FACILITATOR_URL"] || METAL_NETWORKS.testnet.facilitatorUrl,
  });
  x402 = requireSignedOffer(
    registerMetalScheme(new x402ResourceServer(facilitator), { networks: ["testnet"] }),
    { rpcUrl },
  );
}

const app = createStoreApp({
  payTo: payTo || "0x0000000000000000000000000000000000000000",
  inventory,
  orders,
  ...(x402 ? { x402 } : {}),
  onError: (msg) => console.error(`[store] ${msg}`),
});

app.listen(port, "127.0.0.1", () => {
  console.log(`[store] ${mode} mode on http://127.0.0.1:${port} (${orders.list().length} orders)`);
});
