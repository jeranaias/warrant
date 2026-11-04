import type { LoggedEvent } from "../api.js";
import { time } from "../format.js";
import { sellerMoments } from "../seller.js";
import type { SellerMoment } from "../seller.js";

/**
 * Our store's side, as it happens: the buyer's warrant pass it checked before serving, and each
 * dispute it answered from its records. Shows the latest few; nothing until one happens.
 */
export function Seller({
  events,
  max = 3,
  onClose,
}: {
  events: readonly LoggedEvent[];
  max?: number;
  onClose?: () => void;
}) {
  const moments = sellerMoments(events).slice(-max).reverse();
  if (moments.length === 0) return null;
  return (
    <section className="sheet sheet-seller" aria-label="At our store">
      <div className="sheet-head">
        <div className="sheet-k">at our store · seller's view</div>
        {onClose && (
          <button className="drawer-x" onClick={onClose} aria-label="Close">
            ×
          </button>
        )}
      </div>
      {moments.map((m) => (
        <Moment key={m.seq} m={m} />
      ))}
    </section>
  );
}

export function Moment({ m }: { m: SellerMoment }) {
  return (
    <article className={`moment ${m.ok ? "" : "refused"}`}>
      <header>
        <span className={`badge ${m.ok ? (m.kind === "dispute" ? "seal" : "ok") : "stop"}`}>
          {m.kind === "dispute" ? "dispute" : m.ok ? "pass ok" : "refused"}
        </span>
        <span className="moment-title">{m.title}</span>
        <span className="mono muted small">{time(m.at)}</span>
      </header>
      <p className="moment-sum">{m.summary}</p>
      <dl className="facts">
        {m.rows.map((r, i) => (
          <div key={i} className="facts-row">
            <dt>{r.label}</dt>
            <dd className={r.mono ? "mono" : undefined}>{r.value}</dd>
          </div>
        ))}
      </dl>
    </article>
  );
}
