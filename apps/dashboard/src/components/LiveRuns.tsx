import { LIVE_RUNS, METAL_EXPLORER } from "../liveRuns.js";

/** The same flows, run on the real Airwallex sandbox and Metal testnet (docs/TESTNET.md). */
export function LiveRuns() {
  return (
    <section className="panel live-runs">
      <h2>Testnet runs</h2>
      <p className="muted small">
        Same flows, run on the real Airwallex sandbox and Metal testnet. This page runs on simulated
        money.
      </p>
      {LIVE_RUNS.map((run) => (
        <article key={run.title} className="live-run">
          <h3>
            {run.title}
            <span className="muted small">
              {" "}
              · {run.where} · {run.date}
            </span>
          </h3>
          <ol>
            {run.steps.map((s, i) => (
              <li key={i}>
                <span>{s.what}</span>
                <span className="muted">
                  {s.result}
                  {s.tx && (
                    <>
                      {" "}
                      <a
                        className="mono"
                        href={METAL_EXPLORER + s.tx}
                        target="_blank"
                        rel="noreferrer"
                      >
                        {s.tx.slice(0, 10)}…
                      </a>
                    </>
                  )}
                  {s.ref && <span className="mono"> {s.ref}</span>}
                </span>
              </li>
            ))}
          </ol>
        </article>
      ))}
    </section>
  );
}
