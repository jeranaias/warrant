import { startAirwallexMock } from "@warrant/mocks/airwallex";
import { AirwallexCards, AirwallexClient } from "@warrant/rails";
import type { IssuedCard, RailResult } from "@warrant/rails";
import type { Money, PaymentProposal } from "@warrant/contracts";
import { sandboxAirwallexClient } from "./earnings.js";
import type { SceneStep } from "./scenes.js";
import type { SubmitResult } from "@warrant/control";
import { createEngine, killHooks } from "./server.js";
import { AGENTS, CARD_SEAT, CARD_WARRANT_ID, OWNER_ID, makeWorld } from "./world.js";
import type { World } from "./world.js";

/**
 * Kit 2 beat: treasury's virtual Visa card, governed by its warrant twice (control, then the card's
 * own limits), and frozen by the emergency stop.
 */

export interface CardWorld {
  world: World;
  client: AirwallexClient;
  cards: AirwallexCards;
  card: IssuedCard;
  close: () => Promise<void>;
}

/** Where the card lives: a fresh Airwallex mock (default) or the real sandbox. */
export type CardMode = "mock" | "sandbox";

/** `--sandbox`, AIRWALLEX_ENV=sandbox or RAILS_MODE=sandbox. Anything else is the mock. */
export function cardMode(
  argv: readonly string[] = process.argv,
  env: NodeJS.ProcessEnv = process.env,
): CardMode {
  return argv.includes("--sandbox") ||
    env["AIRWALLEX_ENV"] === "sandbox" ||
    env["RAILS_MODE"] === "sandbox"
    ? "sandbox"
    : "mock";
}

/**
 * A world with treasury's card warrant, paid through the Airwallex card adapter. Mock: a fresh
 * Airwallex mock and a new card. Sandbox: the owner's keys from .env; the card is
 * AIRWALLEX_CARD_ID if set (must be ACTIVE), else the account's first ACTIVE card, else a new one.
 * `log` gets the adapter's lines (never card numbers).
 */
export async function cardWorld(
  mode: CardMode = "mock",
  now = new Date(),
  log?: (line: string) => void,
): Promise<CardWorld> {
  let client: AirwallexClient;
  let close = async () => {};
  if (mode === "sandbox") {
    client = sandboxAirwallexClient();
  } else {
    const awx = await startAirwallexMock();
    // The mock accepts any client id and key; nothing here is a real credential.
    client = new AirwallexClient({ baseUrl: awx.url, clientId: "mock", apiKey: "mock" });
    close = () => awx.close();
  }
  const cards = new AirwallexCards(client, { createdBy: "Warrant owner", ...(log ? { log } : {}) });
  const world = makeWorld(now, { card: cards });
  const warrant = world.warrants.get(CARD_WARRANT_ID);
  if (!warrant) throw new Error("no card warrant in this world");
  const cardId = mode === "sandbox" ? process.env["AIRWALLEX_CARD_ID"] : undefined;
  try {
    const card = await cards.issue(warrant, {
      requestId: `warrant-card-${now.getTime()}`,
      ...(cardId ? { cardId } : {}),
    });
    return { world, client, cards, card, close };
  } catch (e) {
    await close();
    throw e;
  }
}

const usd = (cents: number): Money => ({ currency: "USD", cents });
const OVER_CAP = usd(4000);

const said = (r: RailResult) => `${r.status}${r.detail ? ` (${r.detail})` : ""}`;

/** "blocked by rules (per_payment_cap)": who stopped it, and the first check that failed. */
function blocked(r: SubmitResult): string {
  const rule = r.decision?.rules.checks.find((c) => !c.pass)?.rule;
  return `blocked by ${r.blockedBy ?? "?"} (${rule ?? r.error ?? "no reason given"})`;
}

/**
 * 1. treasury buys this month's design tool seat: control approves, the card pays
 * 2. an over-cap purchase: control blocks it before any rail is called
 * 3. the same purchase sent straight to the card, around control: the card's own limit declines it
 * 4. STOP: the kill switch freezes the card; control refuses the next purchase, and the card,
 *    asked directly, declines it as inactive
 *
 * `run` makes idempotency keys unique per run (the sandbox keeps every transaction).
 */
export async function cardScene(
  now = () => new Date(),
  own?: CardWorld,
  run = "1",
): Promise<SceneStep[]> {
  const cw = own ?? (await cardWorld("mock", now()));
  const { cards } = cw;
  const engine = createEngine({ scenario: "none", clock: now, world: cw.world });
  const { controller, world } = engine;
  const steps: SceneStep[] = [];
  const proposal = (n: string, amount: Money): PaymentProposal => ({
    proposalId: `prop_card_${n}_${run}`,
    warrantId: CARD_WARRANT_ID,
    agentId: AGENTS.treasury.agentId,
    agentRole: "treasury",
    rail: "airwallex_card",
    payeeId: CARD_SEAT.payeeId,
    amount,
    category: "software_seat",
    recurrence: "one_off",
    idempotencyKey: `scene-card-${n}-${run}`,
    justification: "This month's design tool seat",
    createdAt: now().toISOString(),
  });
  // Around control: what an agent holding the card could try. Only the card's limits stand.
  const straight = (n: string, amount: Money) =>
    cards.execute({
      rail: "airwallex_card",
      reservationId: `around-control-${n}`,
      idempotencyKey: `scene-card-around-${n}-${run}`,
      amount,
      routingRef: CARD_SEAT.routingRef,
    });
  try {
    steps.push({
      step: "card ready",
      outcome: `${cw.card.source} card, controls ${cw.card.controls}`,
      moneyMoved: false,
    });

    const seat = await controller.submit(proposal("seat", CARD_SEAT.price));
    steps.push({
      step: "treasury buys the design tool seat",
      outcome: seat.execution ? `control approved; card ${said(seat.execution)}` : blocked(seat),
      moneyMoved: seat.execution?.status === "succeeded",
    });

    const over = await controller.submit(proposal("over", OVER_CAP));
    steps.push({
      step: "USD 40.00 purchase, through control",
      outcome: over.execution
        ? `not blocked: ${said(over.execution)}`
        : `${blocked(over)}; card never asked`,
      moneyMoved: over.execution?.status === "succeeded",
    });

    const around = await straight("over", OVER_CAP);
    steps.push({
      step: "the same purchase straight to the card",
      outcome: said(around),
      moneyMoved: around.status === "succeeded",
    });

    const kill = await controller.engageKillSwitch(
      {
        ownerId: OWNER_ID,
        reason: "card scene: owner pressed stop",
        warrantIds: [CARD_WARRANT_ID],
      },
      killHooks(world),
    );
    steps.push({
      step: "STOP",
      outcome: `${kill.event.frozenCardIds.length} card(s) frozen in ${kill.durationMs} ms${
        kill.problems.length ? `; problems: ${kill.problems.join("; ")}` : ""
      }`,
      moneyMoved: false,
    });

    const after = await controller.submit(proposal("after", CARD_SEAT.price));
    steps.push({
      step: "seat purchase after STOP, through control",
      outcome: after.execution ? `not blocked: ${said(after.execution)}` : blocked(after),
      moneyMoved: after.execution?.status === "succeeded",
    });
    const frozen = await straight("after", CARD_SEAT.price);
    steps.push({
      step: "the same purchase straight to the card",
      outcome: said(frozen),
      moneyMoved: frozen.status === "succeeded",
    });
    return steps;
  } finally {
    if (!own) await cw.close();
  }
}
