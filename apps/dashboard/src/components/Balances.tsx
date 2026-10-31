import type { WarrantRow } from "../api.js";
import { agentName, cents, money, percentUsed } from "../format.js";

/** One card per agent: what it is for, what it has spent against its budget, its limits. */
export function Balances({ warrants, stopped }: { warrants: WarrantRow[]; stopped: boolean }) {
  return (
    <section className="panel">
      <h2>Agents and budgets</h2>
      <div className="cards">
        {warrants.map((w) => {
          const pct = percentUsed(w.spentCents, w.totalBudget.cents);
          return (
            <article className="card" key={w.warrantId}>
              <header className="card-head">
                <strong>{agentName(w.agentRole)}</strong>
                <span className={`badge ${stopped ? "stop" : "ok"}`}>
                  {stopped ? "stopped" : "active"}
                </span>
              </header>
              <p className="muted small">{w.purpose}</p>
              <p className="big-number">
                {cents(w.spentCents, w.totalBudget.currency)}
                <span className="muted small"> of {money(w.totalBudget)} spent</span>
              </p>
              <div
                className={`bar ${pct >= 90 ? "hot" : ""}`}
                role="progressbar"
                aria-valuenow={pct}
                aria-valuemin={0}
                aria-valuemax={100}
              >
                <div style={{ width: `${pct}%` }} />
              </div>
              <dl className="facts">
                <dt>Most per payment</dt>
                <dd>{money(w.perPaymentCap)}</dd>
                <dt>May pay</dt>
                <dd>{w.payees.map((p) => p.displayName).join(", ") || "-"}</dd>
                <dt>Warrant</dt>
                <dd className="mono">
                  {w.warrantId} v{w.version}
                </dd>
              </dl>
            </article>
          );
        })}
      </div>
    </section>
  );
}
