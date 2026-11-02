import { useEffect, useRef, useState } from "react";
import type { WarrantRow } from "../api.js";
import { agentName, money } from "../format.js";
import { paidByCurrency, reasonsOf, tally } from "../flow.js";
import type { Fate, Pass } from "../flow.js";
import { tintOf } from "../tints.js";
import { usePassStream } from "./usePassStream.js";

/**
 * The gate: every payment an agent asks for, drawn as a stream that enters on the left, passes
 * through the warrant in the middle and leaves on the right as paid, waiting for the owner, or
 * blocked. A stream's thickness is the number of requests. Blocked is broken down by reason.
 *
 *   left     one node per agent: name, requests, and a red line once its budget is used up
 *   middle   the warrant (red and labelled STOPPED once the emergency stop is engaged)
 *   right    Paid (money moved, per currency), Held for you (grouped alike), Blocked (reasons)
 *
 * New payments run along their stream as a short bright trail.
 */

const TOP = 36;
/** Room for the agent labels on the left and the outcome labels on the right, in pixels. */
const LEFT = 170;
const RIGHT = 300;
const NODE = 8;
/** Longest outcome line before it is cut, so it never runs under the side panel. */
const LINE_CHARS = 36;
const TRAIL_MS = 1500;
const FATES: Fate[] = ["paid", "asked", "blocked"];
const FATE_COLOR: Record<Fate, string> = {
  paid: "var(--ok)",
  asked: "var(--wait)",
  blocked: "var(--stop)",
};

const f = (n: number) => n.toFixed(1);

interface Band {
  y0: number;
  y1: number;
}

/** A ribbon from one vertical span to another, eased through the middle. */
function ribbon(x0: number, a: Band, x1: number, b: Band): string {
  const m = (x0 + x1) / 2;
  return (
    `M${f(x0)} ${f(a.y0)} C${f(m)} ${f(a.y0)} ${f(m)} ${f(b.y0)} ${f(x1)} ${f(b.y0)}` +
    ` L${f(x1)} ${f(b.y1)} C${f(m)} ${f(b.y1)} ${f(m)} ${f(a.y1)} ${f(x0)} ${f(a.y1)} Z`
  );
}

/** The centre line of a ribbon, for a trail to run along. */
function spine(x0: number, a: Band, x1: number, b: Band): string {
  const ya = (a.y0 + a.y1) / 2;
  const yb = (b.y0 + b.y1) / 2;
  const m = (x0 + x1) / 2;
  return `C${f(m)} ${f(ya)} ${f(m)} ${f(yb)} ${f(x1)} ${f(yb)}`;
}

export function Gate({
  warrants,
  passes,
  stopped,
  motion,
  selected,
  onSelect,
}: {
  warrants: WarrantRow[];
  passes: Pass[];
  stopped: boolean;
  motion: boolean;
  selected: string | null;
  onSelect: (warrantId: string | null) => void;
}) {
  // Draw at the box's real pixel size so text stays the same size however wide the box is.
  const box = useRef<SVGSVGElement>(null);
  const [size, setSize] = useState({ w: 1000, h: 560 });
  useEffect(() => {
    const el = box.current;
    if (!el) return;
    const ro = new ResizeObserver(([e]) => {
      if (e)
        setSize({ w: Math.max(640, e.contentRect.width), h: Math.max(380, e.contentRect.height) });
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  const W = size.w;
  const H = size.h;
  const PLOT = H - TOP * 2;
  const AX = LEFT;
  const OX = W - RIGHT;
  const GX0 = (AX + OX) / 2 - 25;
  const GX1 = GX0 + 50;

  const { total, lanes } = tally(passes);
  const count = total.paid + total.asked + total.blocked;
  const nA = Math.max(1, warrants.length);
  const slot = PLOT / nA;
  const most = Math.max(1, ...warrants.map((w) => sumOf(lanes.get(w.warrantId))));
  // One scale for every stream, so thickness compares across agents and outcomes.
  const k = Math.min((slot * 0.78) / most, (PLOT * 0.62) / Math.max(1, count));
  const thick = (n: number) => (n > 0 ? Math.max(2.5, n * k) : 0);

  // Left: agents in evenly spaced slots.
  const agents = warrants.map((w, i) => {
    const n = sumOf(lanes.get(w.warrantId));
    const h = thick(n);
    const c = TOP + (i + 0.5) * slot;
    return { w, i, n, band: { y0: c - h / 2, y1: c + h / 2 }, c };
  });

  // Middle: the same bands stacked inside the warrant.
  const GAP = 6;
  const inner = agents.reduce((s, a) => s + (a.band.y1 - a.band.y0), 0) + GAP * (nA - 1);
  const gateH = Math.max(180, inner + 40);
  const gateY = H / 2 - gateH / 2;
  let y = H / 2 - inner / 2;
  const atGate = agents.map((a) => {
    const h = a.band.y1 - a.band.y0;
    const band = { y0: y, y1: y + h };
    y += h + (h > 0 ? GAP : 0);
    return band;
  });

  // Right: three outcome nodes; each agent's band splits into its share of each.
  const outN: Record<Fate, number> = {
    paid: total.paid,
    asked: total.asked,
    blocked: total.blocked,
  };
  const outSlot = PLOT / 3;
  const outTop: Record<Fate, number> = { paid: 0, asked: 0, blocked: 0 };
  const outH: Record<Fate, number> = { paid: 0, asked: 0, blocked: 0 };
  for (const [j, fate] of FATES.entries()) {
    outH[fate] = agents.reduce((s, a) => s + share(a, fate), 0);
    outTop[fate] = TOP + (j + 0.5) * outSlot - outH[fate] / 2;
  }
  function share(a: (typeof agents)[number], fate: Fate): number {
    const lane = lanes.get(a.w.warrantId);
    if (!lane || a.n === 0) return 0;
    return ((a.band.y1 - a.band.y0) * lane[fate]) / a.n;
  }
  const fill: Record<Fate, number> = { ...outTop };
  const splits = agents.map((a, i) => {
    const g = atGate[i] ?? a.band;
    let gy = g.y0;
    return FATES.map((fate) => {
      const h = share(a, fate);
      const from = { y0: gy, y1: gy + h };
      const to = { y0: fill[fate], y1: fill[fate] + h };
      gy += h;
      fill[fate] += h;
      return { fate, h, from, to };
    });
  });

  // Trails for new payments, along agent -> gate -> outcome.
  const [shots, setShots] = useState<{ key: number; d: string; fate: Fate; color: string }[]>([]);
  const geo = useRef({ agents, atGate, splits, motion, AX, GX0, GX1, OX });
  geo.current = { agents, atGate, splits, motion, AX, GX0, GX1, OX };
  const timers = useRef<number[]>([]);
  useEffect(() => () => timers.current.forEach((t) => clearTimeout(t)), []);
  usePassStream(passes, warrants.length > 0, (fresh) => {
    if (!geo.current.motion) return;
    fresh.forEach((p, n) => {
      timers.current.push(
        window.setTimeout(() => {
          const g = geo.current;
          const i = g.agents.findIndex((a) => a.w.warrantId === p.warrantId);
          const a = g.agents[i];
          const at = g.atGate[i];
          const s = g.splits[i]?.find((x) => x.fate === p.fate);
          if (!a || !at || !s) return;
          const y0 = (a.band.y0 + a.band.y1) / 2;
          const d =
            `M${f(g.AX)} ${f(y0)} ${spine(g.AX, a.band, g.GX0, at)}` +
            ` L${f(g.GX1)} ${f((s.from.y0 + s.from.y1) / 2)} ${spine(g.GX1, s.from, g.OX, s.to)}`;
          const color = p.fate === "paid" ? tintOf(i) : FATE_COLOR[p.fate];
          setShots((all) => [...all.slice(-11), { key: p.seq, d, fate: p.fate, color }]);
        }, n * 320),
      );
    });
  });

  const reasons = reasonsOf(passes);
  const held = heldGroups(passes, warrants);
  const paid = paidByCurrency(passes);
  const dim = (id: string) => selected !== null && selected !== id;

  return (
    <svg
      ref={box}
      className={`gt${stopped ? " is-stopped" : ""}`}
      viewBox={`0 0 ${W} ${H}`}
      preserveAspectRatio="xMidYMid meet"
      role="img"
      aria-label={`${count} payment requests: ${total.paid} paid, ${total.asked} waiting for you, ${total.blocked} blocked`}
    >
      {agents.map((a, i) => (
        <g key={a.w.warrantId} className={`gt-lane${dim(a.w.warrantId) ? " dim" : ""}`}>
          {a.n > 0 && (
            <path
              className="gt-in"
              d={ribbon(AX, a.band, GX0, atGate[i] ?? a.band)}
              fill={tintOf(i)}
            />
          )}
          {splits[i]?.map(
            (s) =>
              s.h > 0 && (
                <path
                  key={s.fate}
                  className={`gt-out ${s.fate}`}
                  d={ribbon(GX1, s.from, OX, s.to)}
                  fill={FATE_COLOR[s.fate]}
                />
              ),
          )}
        </g>
      ))}

      {agents.map((a) => {
        const out = a.w.totalBudget.cents > 0 && a.w.spentCents >= a.w.totalBudget.cents;
        return (
          <g
            key={a.w.warrantId}
            className={`gt-agent${dim(a.w.warrantId) ? " dim" : ""}${selected === a.w.warrantId ? " sel" : ""}`}
            onClick={() => onSelect(a.w.warrantId)}
            role="button"
            tabIndex={0}
            aria-label={`${agentName(a.w.agentRole)}: ${a.n} requests`}
            onKeyDown={(e) => {
              if (e.key === "Enter" || e.key === " ") onSelect(a.w.warrantId);
            }}
          >
            <rect
              x={AX - NODE}
              y={Math.min(a.band.y0, a.c - 14)}
              width={NODE}
              height={Math.max(28, a.band.y1 - a.band.y0)}
              rx={2}
              fill={tintOf(a.i)}
            />
            <text className="gt-name" x={AX - 20} y={a.c - 4} textAnchor="end">
              {agentName(a.w.agentRole).replace(/ agent$/, "")}
            </text>
            <text className="gt-sub" x={AX - 20} y={a.c + 14} textAnchor="end">
              {a.n} {a.n === 1 ? "request" : "requests"}
            </text>
            {out && (
              <text className="gt-sub stop" x={AX - 20} y={a.c + 30} textAnchor="end">
                budget used up
              </text>
            )}
          </g>
        );
      })}

      <g className="gt-gate">
        <rect x={GX0} y={gateY} width={GX1 - GX0} height={gateH} rx={5} />
        {atGate.map(
          (b, i) =>
            b.y1 > b.y0 && (
              <rect
                key={i}
                className="gt-slot"
                x={GX0 + 6}
                y={b.y0}
                width={GX1 - GX0 - 12}
                height={b.y1 - b.y0}
                fill={tintOf(i)}
              />
            ),
        )}
        <text x={(GX0 + GX1) / 2} y={gateY - 12} textAnchor="middle" className="gt-gate-k">
          {stopped ? "STOPPED" : "WARRANT"}
        </text>
        <text x={(GX0 + GX1) / 2} y={gateY + gateH + 20} textAnchor="middle" className="gt-sub">
          {warrants.length} signed
        </text>
      </g>

      {FATES.map((fate, j) => {
        const c = TOP + (j + 0.5) * outSlot;
        const h = Math.max(outH[fate], 4);
        const lines =
          fate === "paid"
            ? paid.map((m) => money(m))
            : fate === "asked"
              ? held.slice(0, 2).map((g) => `${g.n} × ${g.text}`)
              : reasons.slice(0, 4).map((r) => `${r.n}  ${r.reason}`);
        const more =
          fate === "blocked" && reasons.length > 4
            ? reasons.slice(4).reduce((s, r) => s + r.n, 0)
            : 0;
        const head = fate === "paid" ? "Paid" : fate === "asked" ? "Held for you" : "Blocked";
        const ty = c - 10 - (lines.length * 17) / 2 + 6;
        return (
          <g key={fate} className={`gt-node ${fate}`}>
            <rect x={OX} y={c - h / 2} width={NODE} height={h} rx={2} />
            <text className="gt-head" x={OX + 22} y={ty}>
              {head} · {outN[fate]}
            </text>
            {lines.map((l, n) => (
              <text key={n} className="gt-line" x={OX + 22} y={ty + 20 + n * 17}>
                {clip(l)}
              </text>
            ))}
            {more > 0 && (
              <text className="gt-line muted" x={OX + 22} y={ty + 20 + lines.length * 17}>
                {more} other
              </text>
            )}
          </g>
        );
      })}

      {count === 0 && (
        <text className="gt-sub" x={(GX0 + GX1) / 2} y={H / 2 + 4} textAnchor="middle">
          no requests yet
        </text>
      )}

      {shots.map((s) => (
        <Trail
          key={s.key}
          d={s.d}
          fate={s.fate}
          color={s.color}
          onEnd={() => setShots((all) => all.filter((x) => x.key !== s.key))}
        />
      ))}
    </svg>
  );
}

function clip(s: string): string {
  return s.length > LINE_CHARS ? `${s.slice(0, LINE_CHARS - 1)}…` : s;
}

function sumOf(t: { paid: number; asked: number; blocked: number } | undefined): number {
  return t ? t.paid + t.asked + t.blocked : 0;
}

/** Waiting requests folded by agent, payee and amount: "21 × Sourcing → Upstream 0.02". */
function heldGroups(passes: Pass[], warrants: WarrantRow[]): { text: string; n: number }[] {
  const by = new Map<string, { text: string; n: number }>();
  for (const p of passes) {
    if (p.fate !== "asked") continue;
    const w = warrants.find((x) => x.warrantId === p.warrantId);
    const payee =
      w?.payees.find((x) => x.payeeId === p.payee)?.displayName ?? (w ? "customer" : p.payee);
    const who = agentName(w?.agentRole).replace(/ agent$/, "");
    const text = `${money(p.amount)} · ${who} → ${payee}`;
    const g = by.get(text) ?? { text, n: 0 };
    g.n += 1;
    by.set(text, g);
  }
  return [...by.values()].sort((a, b) => b.n - a.n);
}

/** One payment: a short bright segment running along its stream. */
function Trail({
  d,
  fate,
  color,
  onEnd,
}: {
  d: string;
  fate: Fate;
  color: string;
  onEnd: () => void;
}) {
  const path = useRef<SVGPathElement>(null);
  const head = useRef<SVGCircleElement>(null);
  const done = useRef(onEnd);
  done.current = onEnd;

  useEffect(() => {
    const p = path.current;
    const h = head.current;
    if (!p || !h) return;
    const len = p.getTotalLength();
    const seg = Math.min(90, len * 0.3);
    const start = performance.now();
    let raf = 0;
    const tick = (now: number) => {
      const t = Math.min(1, (now - start) / TRAIL_MS);
      const e = t < 0.5 ? 2 * t * t : 1 - (-2 * t + 2) ** 2 / 2;
      const pos = len * e;
      const pt = p.getPointAtLength(pos);
      h.setAttribute("cx", f(pt.x));
      h.setAttribute("cy", f(pt.y));
      p.style.strokeDasharray = `${f(Math.min(seg, pos))} ${f(len)}`;
      p.style.strokeDashoffset = f(-Math.max(0, pos - seg));
      if (t < 1) raf = requestAnimationFrame(tick);
      else done.current();
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, []);

  return (
    <g className={`gt-trail ${fate}`} style={{ color }}>
      <path ref={path} d={d} />
      <circle ref={head} r={4} />
    </g>
  );
}

/** The phone's gate: the same three outcomes as one stacked bar, and the top block reason. */
export function GateBar({ passes, stopped }: { passes: Pass[]; stopped: boolean }) {
  const { total } = tally(passes);
  const count = total.paid + total.asked + total.blocked;
  const top = reasonsOf(passes)[0];
  return (
    <div className={`gt-bar${stopped ? " is-stopped" : ""}`}>
      <div className="gt-bar-k">{stopped ? "stopped" : `through the warrant · ${count}`}</div>
      <div className="gt-bar-track" aria-hidden="true">
        {FATES.map((fate) =>
          total[fate] > 0 ? (
            <span key={fate} className={fate} style={{ flexGrow: total[fate] }} />
          ) : null,
        )}
      </div>
      {top && (
        <div className="gt-bar-why">
          most blocked: <b>{top.reason}</b> · {top.n}
        </div>
      )}
    </div>
  );
}
