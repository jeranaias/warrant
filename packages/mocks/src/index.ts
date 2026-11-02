import { fileURLToPath } from "node:url";
import { startAirwallexMock } from "./airwallex/index.js";
import { MockMetalChain, addUpstream } from "./metal/index.js";
import { startMetalMock } from "./metal/server.js";

// `pnpm mocks` runs from packages/mocks, so reach the repo-root .env explicitly.
try {
  process.loadEnvFile(fileURLToPath(new URL("../../../.env", import.meta.url)));
} catch {
  // No .env: fall back to the defaults from .env.example.
}

const airwallex = await startAirwallexMock({
  port: Number(process.env.MOCK_AIRWALLEX_PORT ?? 4010),
});
console.log(`mock airwallex listening on ${airwallex.url}`);

const chain = new MockMetalChain();
const metal = await startMetalMock({
  chain,
  upstream: addUpstream(chain, 2),
  port: Number(process.env.MOCK_METAL_PORT ?? 4020),
});
console.log(`mock metal listening on ${metal.url} (upstream 402 at ${metal.url}/forecast/eurusd)`);
