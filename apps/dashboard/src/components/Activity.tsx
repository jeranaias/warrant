import { useState } from "react";
import type { LoggedEvent, WarrantRow } from "../api.js";
import { TONE_WORDS, describe, foldRepeats, namesOf, time } from "../format.js";
import { Replay } from "./Replay.js";

/**
 * What happened, newest first, in plain words. Every block or hold carries its reason, in
 * control's words (never the agent's). Alike lines in a row fold into one ("×20"). Wording lives
 * in format.ts (describe, whyOf). A line about a request opens its replay; `open` and `onOpen`
 * let the page open one from elsewhere (the gate's Paid / Held / Blocked).
 */
export function Activity({
  events,
  warrants,
  limit = 100,
  open,
  onOpen,
}: {
  events: LoggedEvent[];
  warrants: WarrantRow[];
  limit?: number;
  open?: string | null;
  onOpen?: (proposalId: string | null) => void;
}) {
  const [own, setOwn] = useState<string | null>(null);
  const opened = open === undefined ? own : open;
  const setOpened = onOpen ?? setOwn;
  const names = namesOf(events, warrants);
  if (opened) {
    return (
      <section className="panel">
        <h2>Request</h2>
        <Replay
          proposalId={opened}
          names={names}
          version={events.length}
          onClose={() => setOpened(null)}
          closeLabel="All activity"
        />
      </section>
    );
  }
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
          {lines.map(({ item: l, n }) => {
            const row = (
              <>
                <span className="feed-time mono">{time(l.at)}</span>
                <span className="feed-text">
                  {l.text}
                  {n > 1 && <span className="feed-n mono"> ×{n}</span>}
                  {l.why && <span className="feed-why">{l.why}</span>}
                </span>
                <span className={`badge ${l.tone}`}>{TONE_WORDS[l.tone]}</span>
              </>
            );
            const id = l.proposalId;
            return (
              <li key={l.seq} className={`tone-${l.tone}`}>
                {id ? (
                  <button className="feed-open" onClick={() => setOpened(id)}>
                    {row}
                  </button>
                ) : (
                  row
                )}
              </li>
            );
          })}
        </ol>
      )}
    </section>
  );
}
