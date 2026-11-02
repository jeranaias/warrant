import type { AgentRole, BillingPeriod, Money } from "@warrant/contracts";

/**
 * Kit 11 numbers (ADR-009). The brief says prices, budgets and the licence fee stay in code:
 * change them here, never in a prompt or a warrant purpose string.
 */

const usdz = (cents: number): Money => ({ currency: "USDZ", cents });

/** Total across all three agents, enforced in code. */
export const TOTAL_BUDGET = usdz(2000);

export const AGENT_BUDGETS: Readonly<Record<AgentRole, { budget: Money; perPaymentCap: Money }>> = {
  sourcing: { budget: usdz(1000), perPaymentCap: usdz(3) },
  support: { budget: usdz(400), perPaymentCap: usdz(400) },
  treasury: { budget: usdz(600), perPaymentCap: usdz(600) },
};

/** What our store charges per query (GET /query). */
export const QUERY_PRICE = usdz(5);

/** Upstream provider's price before and after the rise. 4 > the 3-cent cap, so it is refused. */
export const UPSTREAM_PRICE_BEFORE = usdz(2);
export const UPSTREAM_PRICE_AFTER = usdz(4);

/**
 * ADR-013: a refund goes through without the owner only up to this amount, and only for the
 * first REFUNDS_WITHOUT_OWNER_PER_DAY refunds to one customer in 24 hours.
 */
export const REFUND_WITHOUT_OWNER_MAX = usdz(25);
export const REFUNDS_WITHOUT_OWNER_PER_DAY = 2;

/** Monthly licence fee, invoiced in euros. Our choice: the brief gives no amount. */
export const LICENCE_FEE: Money = { currency: "EUR", cents: 5000 };

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * ADR-015: a second payment to a payee within this long of the last one waits for the owner,
 * when the warrant gives the payee a billing period. A month is 28 days, the shortest month, so
 * next month's real invoice never waits.
 */
export const BILLING_PERIOD_MS: Readonly<Record<BillingPeriod, number>> = {
  day: DAY_MS,
  week: 7 * DAY_MS,
  month: 28 * DAY_MS,
};

/** Sum of the per-agent budgets. Must equal TOTAL_BUDGET (tested). */
export function sumAgentBudgets(budgets = AGENT_BUDGETS): number {
  return Object.values(budgets).reduce((acc, b) => acc + b.budget.cents, 0);
}

/**
 * A proposed set of agent budgets (treasury's BudgetChangeProposal) must stay within the total
 * and must not drop any agent below what it has already spent (a replaced mandate carries spend
 * forward, so its budget must exceed the spend).
 */
export function validateBudgetPlan(
  plan: Readonly<Record<AgentRole, number>>,
  spentCents: Readonly<Record<AgentRole, number>>,
  totalCents = TOTAL_BUDGET.cents,
): string[] {
  const problems: string[] = [];
  let sum = 0;
  for (const role of ["sourcing", "support", "treasury"] as const) {
    const b = plan[role];
    if (!Number.isInteger(b) || b < 0) problems.push(`${role}: budget must be whole cents >= 0`);
    if (b <= spentCents[role]) {
      problems.push(`${role}: budget ${b} must exceed spent ${spentCents[role]}`);
    }
    sum += b;
  }
  if (sum > totalCents) problems.push(`total ${sum} exceeds ${totalCents}`);
  return problems;
}
