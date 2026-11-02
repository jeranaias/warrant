import { earningsScene, sandboxAirwallexWorld } from "./earnings.js";

/**
 * `pnpm scene:earnings`: the store's earnings move off Metal, land in Airwallex as a deposit, and
 * treasury pays the EUR licence fee (USD converted to EUR, then a transfer) through control.
 * Mock Metal chain and mock Airwallex; nothing real moves.
 *
 * `pnpm scene:earnings --sandbox`: the same, with Airwallex on the real sandbox (owner's keys from
 * .env). The deposit, conversion and transfer are real sandbox objects; Metal stays the mock chain.
 */
const sandbox = process.argv.includes("--sandbox");
const awx = sandbox ? await sandboxAirwallexWorld() : undefined;
console.log(sandbox ? "Airwallex: sandbox · Metal: mock chain" : "Airwallex: mock · Metal: mock");
for (const s of await earningsScene(undefined, awx, sandbox ? String(Date.now()) : "1")) {
  console.log(
    `${s.moneyMoved ? "MOVED  " : "       "}  ${s.step.padEnd(40)} ${s.outcome}${s.tx ? `  [${s.tx}]` : ""}`,
  );
}
