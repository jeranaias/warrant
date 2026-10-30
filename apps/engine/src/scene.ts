import { limitChangeScene } from "./scenes.js";

/**
 * `pnpm scene`: on the mock chain, the price rises from 2 cents to 4 and is refused; then the
 * owner approves treasury's new 4-cent cap and buying resumes. Prints each step.
 */
const steps = await limitChangeScene();
for (const s of steps) {
  console.log(`${s.moneyMoved ? "PAID   " : "STOPPED"}  ${s.step.padEnd(36)} ${s.outcome}`);
}
