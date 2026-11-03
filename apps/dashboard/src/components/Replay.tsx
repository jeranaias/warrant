import { useEffect, useState } from "react";
import { api } from "../api.js";
import { time } from "../format.js";
import type { Names } from "../format.js";
import { outcomeLine, replayLines } from "../replay.js";
import type { Replay as ReplayData } from "../replay.js";

/**
 * One request, step by step (GET /replay): what the agent asked, each rule, the purpose check,
 * the owner, the ledger and the rail. One plain line per step; ids in the small line under it.
 * `version` refetches when the log moves (a held request gets decided while it is open).
 */
export function Replay({
  proposalId,
  names,
  version,
  onClose,
  closeLabel = "Back",
}: {
  proposalId: string;
  names: Names;
  version: number;
  onClose: () => void;
  closeLabel?: string;
}) {
  const [data, setData] = useState<ReplayData | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let live = true;
    api
      .replay(proposalId)
      .then((r) => {
        if (!live) return;
        setData(r);
        setError(null);
      })
      .catch((e: unknown) => {
        if (live) setError(e instanceof Error ? e.message : String(e));
      });
    return () => {
      live = false;
    };
  }, [proposalId, version]);

  const head = data ? outcomeLine(data) : null;
  return (
    <div className="replay">
      <div className="replay-top">
        <button className="link-btn" onClick={onClose}>
          ← {closeLabel}
        </button>
        {head && <span className={`badge ${head.tone}`}>{head.text}</span>}
      </div>
      {error && !data && <p className="muted small">Couldn't load this request: {error}</p>}
      {!data && !error && <p className="muted small">Loading…</p>}
      {data && (
        <ol className="replay-steps">
          {replayLines(data, names).map((l, i) => (
            <li key={i} className={`tone-${l.tone}`}>
              <span className="replay-dot" aria-hidden="true" />
              <span className="feed-time mono">{time(l.at)}</span>
              <span className="feed-text">
                {l.text}
                {l.why && <span className="feed-why">{l.why}</span>}
                {l.checks && (
                  <ul className="replay-checks">
                    {l.checks.map((c) => (
                      <li key={c.label} className={c.ok ? "ok" : "stop"}>
                        <span aria-hidden="true">{c.ok ? "✓" : "✕"}</span> {c.label}
                        {c.detail && <span className="muted"> · {c.detail}</span>}
                      </li>
                    ))}
                  </ul>
                )}
                {l.ids && <span className="replay-ids mono">{l.ids}</span>}
              </span>
            </li>
          ))}
        </ol>
      )}
    </div>
  );
}
