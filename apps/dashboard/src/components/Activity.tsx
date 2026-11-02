import type { LoggedEvent } from "../api.js";
import { describe, time } from "../format.js";

/** What happened, newest first, in plain words. Wording lives in format.ts (describe). */
export function Activity({ events, limit = 100 }: { events: LoggedEvent[]; limit?: number }) {
  const lines = events.map(describe).reverse().slice(0, limit);
  return (
    <section className="panel">
      <h2>Live activity</h2>
      {lines.length === 0 ? (
        <p className="muted">Nothing yet. Start the agents or load a scenario.</p>
      ) : (
        <ol className="feed">
          {lines.map((l) => (
            <li key={l.seq} className={`tone-${l.tone}`}>
              <span className="muted small mono">{time(l.at)}</span> {l.text}
            </li>
          ))}
        </ol>
      )}
    </section>
  );
}
