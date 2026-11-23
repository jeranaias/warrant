import { shortAddress } from "../format.js";
import { LIVE_BADGES, LIVE_RUNS, METAL_EXPLORER } from "../liveRuns.js";

/**
 * The same flows, run on the real Airwallex sandbox and Metal testnet (docs/TESTNET.md): one card
 * per flow, one row per step with how it ended, transactions linked to the explorer.
 */
export function LiveRuns() {
  return (
    <section className="panel live-runs">
      <h2>Testnet runs</h2>
      <p className="muted small">
        Same flows, run on the real Airwallex sandbox and Metal testnet. This page runs on simulated
        money.
      </p>
      <div className="live-grid">
        {LIVE_RUNS.map((run) => (
          <article key={run.title} className="live-run">
            <header>
              <h3>{run.title}</h3>
              <span className="badge">{run.where}</span>
              <span className="mono muted small">{run.date}</span>
            </header>
            <ol>
              {run.steps.map((s, i) => {
                const b = LIVE_BADGES[s.tone];
                return (
                  <li key={i}>
                    <span className="live-n mono">{i + 1}</span>
                    <span className="live-main">
                      <span className="live-what">{s.what}</span>
                      <span className="live-result">
                        {s.result}
                        {s.code && <span className="mono"> · {s.code}</span>}
                      </span>
                      {s.tx && (
                        <a
                          className="live-tx mono"
                          href={METAL_EXPLORER + s.tx}
                          target="_blank"
                          rel="noreferrer"
                          title={s.tx}
                        >
                          tx {shortAddress(s.tx)} ↗
                        </a>
                      )}
                      {s.ref && <span className="live-tx mono">Airwallex id {s.ref}</span>}
                    </span>
                    <span className={`badge ${b.badge}`}>{b.label}</span>
                  </li>
                );
              })}
            </ol>
          </article>
        ))}
      </div>
    </section>
  );
}
