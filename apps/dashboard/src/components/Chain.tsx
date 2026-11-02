import type { ChainView } from "../api.js";
import { cents, mandateName, time } from "../format.js";

/**
 * The (mock) Metal chain: each mandate's on-chain limits and spend, and every payment the chain
 * itself refused. This is the second wall: even a payment that got past control stops here.
 */
export function Chain({ chain }: { chain: ChainView }) {
  return (
    <section className="panel">
      <h2>On-chain mandates</h2>
      <p className="muted small">
        Data supplier's price {cents(chain.upstreamPriceCents)} per call. {chain.payments}{" "}
        payment(s) on chain. Treasury pays through Airwallex, so it has no mandate here.
        {chain.mandates.some((m) => /-v\d+\.json$/.test(m.credential)) &&
          " A new version keeps the spend of the one it replaces, so its budget still counts it."}
      </p>
      <table className="grid">
        <thead>
          <tr>
            <th>Mandate</th>
            <th>Per payment</th>
            <th>Budget</th>
            <th>Spent</th>
            <th>State</th>
          </tr>
        </thead>
        <tbody>
          {chain.mandates.map((m) => (
            <tr key={m.credential}>
              <td title={m.credential}>{mandateName(m.credential)}</td>
              <td>{cents(m.capCents)}</td>
              <td>{cents(m.budgetCents)}</td>
              <td>{cents(m.spentCents)}</td>
              <td>
                <span className={`badge ${m.revoked ? "stop" : "ok"}`}>
                  {m.revoked ? "revoked" : "live"}
                </span>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      <h3>Refused by the chain ({chain.refusals.length})</h3>
      {chain.refusals.length === 0 ? (
        <p className="muted small">None.</p>
      ) : (
        <ol className="feed">
          {[...chain.refusals].reverse().map((r, i) => (
            <li key={`${r.at}-${i}`} className="tone-stop">
              <span className="muted small mono">{time(r.at)}</span> {cents(r.cents)} to{" "}
              <span className="mono">{r.to}</span>: {r.reason}
            </li>
          ))}
        </ol>
      )}
    </section>
  );
}
