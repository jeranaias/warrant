import { cardMode, cardScene, cardWorld } from "./card.js";

/**
 * `pnpm scene:card`: treasury's virtual Visa card (Kit 2). The seat is paid; an over-cap purchase
 * is blocked by control, and declined by the card's own limits when sent around control; STOP
 * freezes the card and the card declines the next purchase. Mock Airwallex by default.
 *
 * `pnpm scene:card --sandbox` (or AIRWALLEX_ENV=sandbox / RAILS_MODE=sandbox): the real Airwallex
 * sandbox with the owner's keys from .env (AIRWALLEX_BASE_URL, AIRWALLEX_CLIENT_ID,
 * AIRWALLEX_API_KEY). The card is AIRWALLEX_CARD_ID if set, else the first ACTIVE card, else a new
 * one; its controls are set to the warrant's. STOP leaves that card INACTIVE: unfreeze it in the
 * Airwallex web app before the next run.
 */
const mode = cardMode();
console.log(mode === "sandbox" ? "Airwallex: sandbox" : "Airwallex: mock");
const cw = await cardWorld(mode, new Date(), (line) => console.log(`  card · ${line}`));
try {
  for (const s of await cardScene(undefined, cw, mode === "sandbox" ? String(Date.now()) : "1")) {
    console.log(`${s.moneyMoved ? "PAID   " : "       "}  ${s.step.padEnd(42)} ${s.outcome}`);
  }
} finally {
  await cw.close();
}
