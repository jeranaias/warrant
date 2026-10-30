import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { HTTPFacilitatorClient, x402ResourceServer } from "@x402/core/server";
import { METAL_NETWORKS, registerMetalScheme } from "@metalntwx/metal-pay";
import { requireSignedOffer } from "@metalntwx/metal-pay/mandates";
import { PassChecker } from "@warrant/control";
import { sampleInventory } from "./catalog.js";
import { OrderStore } from "./orders.js";
import { createStoreApp } from "./server.js";

/**
 * Starts our store. RAILS_MODE=mock serves unpaid (for UI work). RAILS_MODE=sandbox charges real
 * testnet USDZ through Metal's facilitator and requires the buyer's signed order.
 *
 * Warrant pass (ADR-012): STORE_REQUIRE_PASS=1 serves only buyers whose `x-warrant-pass` checks
 * out; 0 serves without checking. Default: on in sandbox, off in mock. In mock mode nothing is
 * paid or settled, so the check is the same signatures-and-fit check but no payer key is ever
 * pinned (that needs a settlement). STORE_PUBLIC_ORIGIN is our URL as buyers see it, if not the
 * Host header (e.g. behind a tunnel).
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

const requirePass = (process.env["STORE_REQUIRE_PASS"] ?? (mode === "mock" ? "0" : "1")) === "1";
const storeAddress = payTo || "0x0000000000000000000000000000000000000000";
const publicOrigin = process.env["STORE_PUBLIC_ORIGIN"];

const app = createStoreApp({
  payTo: storeAddress,
  inventory,
  orders,
  ...(x402 ? { x402 } : {}),
  ...(requirePass
    ? { passes: new PassChecker({ payTo: storeAddress, category: "data_purchase" }) }
    : {}),
  ...(publicOrigin ? { publicOrigin } : {}),
  onError: (msg) => console.error(`[store] ${msg}`),
});

app.listen(port, "127.0.0.1", () => {
  const pass = requirePass ? "passes required" : "passes not checked";
  console.log(
    `[store] ${mode} mode on http://127.0.0.1:${port}, ${pass} (${orders.list().length} orders)`,
  );
});
