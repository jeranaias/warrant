import { disputeScene } from "./scenes.js";

/**
 * `pnpm scene:dispute`: a customer disputes; the store decides from its signed orders, the
 * settlement and the customer's warrant pass; support refunds the one bad order by `mandate pull`
 * and nothing else. Mock chain only for now (the testnet settlement check is a follow-up).
 */
for (const s of await disputeScene()) {
  console.log(`${s.moneyMoved ? "PAID   " : "       "}  ${s.step.padEnd(40)} ${s.outcome}`);
}
