import type { LoggedEvent } from "../api.js";
import { TONE_WORDS, describe, time } from "../format.js";

/**
 * What happened, newest first, in plain words. Every block or hold carries its reason, in
 * control's words (never the agent's). Wording lives in format.ts (describe, whyOf).
 */
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
              <span className="feed-time mono">{time(l.at)}</span>
              <span className="feed-text">
                {l.text}
                {l.why && <span className="feed-why">{l.why}</span>}
              </span>
              <span className={`badge ${l.tone}`}>{TONE_WORDS[l.tone]}</span>
            </li>
          ))}
        </ol>
      )}
    </section>
  );
}
