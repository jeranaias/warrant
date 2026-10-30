import { priceRiseScene } from "./scenes.js";

/** `pnpm scene`: plays the 2-cent to 4-cent price rise on the mock chain and prints each step. */
const steps = await priceRiseScene();
for (const s of steps) {
  console.log(`${s.moneyMoved ? "PAID   " : "STOPPED"}  ${s.step.padEnd(36)} ${s.outcome}`);
}
