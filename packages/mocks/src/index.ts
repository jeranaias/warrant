import { fileURLToPath } from "node:url";
import { startAirwallexMock } from "./airwallex/index.js";

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
// TODO(mocks): start the Metal mock on MOCK_METAL_PORT.
