import type { LoggedEvent, WarrantRow } from "../api.js";
import { TONE_WORDS, describe, foldRepeats, namesOf, time } from "../format.js";

/**
 * What happened, newest first, in plain words. Every block or hold carries its reason, in
 * control's words (never the agent's). Alike lines in a row fold into one ("×20"). Wording lives
 * in format.ts (describe, whyOf).
 */
export function Activity({
  events,
  warrants,
  limit = 100,
}: {
  events: LoggedEvent[];
  warrants: WarrantRow[];
  limit?: number;
}) {
  const names = namesOf(events, warrants);
  const lines = foldRepeats(
    events.map((e) => describe(e, names)),
    (l) => `${l.tone}|${l.text}|${l.why ?? ""}`,
  )
    .reverse()
    .slice(0, limit);
  return (
    <section className="panel">
      <h2>Live activity</h2>
      {lines.length === 0 ? (
        <p className="muted">Nothing yet. Start the agents or load a scenario.</p>
      ) : (
        <ol className="feed">
          {lines.map(({ item: l, n }) => (
            <li key={l.seq} className={`tone-${l.tone}`}>
              <span className="feed-time mono">{time(l.at)}</span>
              <span className="feed-text">
                {l.text}
                {n > 1 && <span className="feed-n mono"> ×{n}</span>}
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
