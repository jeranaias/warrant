import { earningsScene } from "./earnings.js";

/**
 * `pnpm scene:earnings`: the store's earnings move off Metal, land in Airwallex as a deposit, and
 * treasury pays the EUR licence fee (USD converted to EUR, then a transfer) through control.
 * Mock Metal chain and mock Airwallex; nothing real moves.
 */
for (const s of await earningsScene()) {
  console.log(`${s.moneyMoved ? "MOVED  " : "       "}  ${s.step.padEnd(40)} ${s.outcome}`);
}
