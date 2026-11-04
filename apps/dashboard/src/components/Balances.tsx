import type { WarrantRow } from "../api.js";
import { cents, money, percentUsed, warrantName } from "../format.js";

/**
 * One card per agent, answering "how much is left, and what may it do": money left against its
 * budget, the bar of what is used, and its warrant's limits in one line.
 */
export function Balances({ warrants, stopped }: { warrants: WarrantRow[]; stopped: boolean }) {
  return (
    <section className="panel">
      <h2>Agents and budgets</h2>
      <div className="cards">
        {warrants.map((w) => {
          const pct = percentUsed(w.spentCents, w.totalBudget.cents);
          const left = Math.max(0, w.totalBudget.cents - w.spentCents);
          return (
            <article className="card agent" key={w.warrantId}>
              <header className="card-head">
                <strong>{warrantName(w.warrantId, w.agentRole)}</strong>
                <span className={`badge ${stopped ? "stop" : "seal"}`}>
                  {stopped ? "stopped" : `warrant v${w.version}`}
                </span>
              </header>
              <p className="big-number">
                <span className="nowrap">{cents(left, w.totalBudget.currency)}</span>
                <span className="muted small"> left of {money(w.totalBudget)}</span>
              </p>
              <div
                className={`bar ${pct >= 90 ? "hot" : ""}`}
                role="progressbar"
                aria-label={`${pct}% of the budget used`}
                aria-valuenow={pct}
                aria-valuemin={0}
                aria-valuemax={100}
              >
                <div style={{ width: `${pct}%` }} />
              </div>
              <p className="muted small">{w.purpose}</p>
              <dl className="facts">
                <dt>Most per payment</dt>
                <dd className="num">{money(w.perPaymentCap)}</dd>
                <dt>May pay</dt>
                <dd>
                  {w.payees.map((p) => p.displayName).join(", ") || "customers (refunds only)"}
                </dd>
                <dt>Warrant</dt>
                <dd className="mono">{w.warrantId}</dd>
              </dl>
            </article>
          );
        })}
      </div>
    </section>
  );
}
