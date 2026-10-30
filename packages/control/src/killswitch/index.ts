import type { KillSwitchEvent } from "@warrant/contracts";

/**
 * The owner's emergency stop. Engaging it is one in-memory flip, so control refuses every new
 * payment at once (rule `warrant_active`), before the slower outside steps finish: freezing
 * Airwallex cards (lane B's CardControls) and revoking the Metal mandates (owner side). Payments
 * already handed to a rail can't be recalled; they settle or fail and the ledger records which.
 * There is no "un-kill": the owner signs new warrants to start again.
 */

export interface KillSwitchHooks {
  /** Lane B: freeze every agent card (`CardControls.freezeAll`). */
  freezeCards?: () => Promise<{ frozenCardIds: string[] }>;
  /** Owner side: revoke every Metal mandate (`metal-agent mandate revoke`). Returns what it revoked. */
  revokeMandates?: () => Promise<string[]>;
}

export interface KillSwitchResult {
  event: KillSwitchEvent;
  revokedMandates: string[];
  /** Outside steps that failed; control has stopped all payments regardless. */
  problems: string[];
  /** From the press to the last outside step done. */
  durationMs: number;
}

export class KillSwitch {
  private result: KillSwitchResult | undefined;
  private engagedAt: Date | undefined;

  get engaged(): boolean {
    return this.engagedAt !== undefined;
  }

  /** The last completed engagement, if any. */
  get last(): KillSwitchResult | undefined {
    return this.result;
  }

  /** Step one, synchronous: from here on control refuses everything. */
  flip(now: Date): void {
    this.engagedAt ??= now;
  }

  /** The outside steps, run side by side; a failing one is reported, never fatal. */
  async finish(
    base: Omit<KillSwitchEvent, "frozenCardIds">,
    hooks: KillSwitchHooks,
    clock: () => Date,
  ): Promise<KillSwitchResult> {
    const problems: string[] = [];
    const settle = async <T>(what: string, f: (() => Promise<T>) | undefined, none: T) => {
      if (!f) return none;
      try {
        return await f();
      } catch (e) {
        problems.push(`${what}: ${(e as Error).message}`.slice(0, 200));
        return none;
      }
    };
    const [cards, mandates] = await Promise.all([
      settle("freeze cards", hooks.freezeCards, { frozenCardIds: [] as string[] }),
      settle("revoke mandates", hooks.revokeMandates, [] as string[]),
    ]);
    const started = this.engagedAt ?? clock();
    this.result = {
      event: { ...base, frozenCardIds: cards.frozenCardIds },
      revokedMandates: mandates,
      problems,
      durationMs: clock().getTime() - started.getTime(),
    };
    return this.result;
  }
}
