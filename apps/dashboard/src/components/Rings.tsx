import { useEffect, useRef, useState } from "react";
import type { Money, PendingApproval, WarrantRow } from "../api.js";
import { agentName, cents, field, money } from "../format.js";
import { leftFraction } from "../flow.js";
import type { Fate, Pass } from "../flow.js";
import { tintOf } from "../tints.js";
import { usePassStream } from "./usePassStream.js";

/**
 * The picture the desktop page is built around, flat and read like a gauge:
 *
 *   rings     one per agent. The coloured arc is the budget left, from 12 o'clock clockwise.
 *   circle    the warrant. Each payee has a port on it.
 *   payees    outside the circle.
 *   trails    payments. In the agent's colour they run out to the payee; red ones stop at the
 *             circle; amber ones wait at the circle for the owner.
 *
 * `compact` draws the rings and the circle only (the phone page).
 */
const RED = "var(--stop)";
const AMBER = "var(--wait)";
const TRAIL_MS = 1400;

interface Shot {
  key: number;
  d: string;
  color: string;
  fate: Fate;
  end: Pt;
}
type Pt = { x: number; y: number };

/** The point `share` of the way round a circle of radius r, clockwise from 12 o'clock. */
const at = (r: number, share: number): Pt => ({
  x: Math.sin(share * Math.PI * 2) * r,
  y: -Math.cos(share * Math.PI * 2) * r,
});
const f = (n: number) => n.toFixed(1);

export function Rings({
  warrants,
  payees = [],
  paidTo,
  passes = [],
  approvals = [],
  stopped,
  motion = true,
  selected = null,
  onSelect,
  compact = false,
}: {
  warrants: WarrantRow[];
  payees?: { id: string; name: string }[];
  paidTo?: Map<string, Money>;
  passes?: Pass[];
  approvals?: PendingApproval[];
  stopped: boolean;
  motion?: boolean;
  selected?: string | null;
  onSelect?: (warrantId: string | null) => void;
  compact?: boolean;
}) {
  const n = warrants.length;
  const width = compact ? 20 : 24;
  const gap = n > 1 ? Math.min(compact ? 30 : 36, 170 / (n - 1)) : 36;
  const r0 = compact ? 70 : 104;
  const radius = (i: number) => r0 + i * gap;
  const rb = radius(Math.max(0, n - 1)) + (compact ? 34 : 48);
  const rg = rb + 82;
  const half = compact ? rb + 16 : rg + 40;
  const halfW = compact ? half : rg + 230;

  // Payees spread evenly, half a step off 12 o'clock so the ring names stay clear.
  const gates = payees.map((p, k) => {
    const share = (k + 0.5) / payees.length;
    return { ...p, share, port: at(rb, share), pos: at(rg, share) };
  });
  const ringIndex = new Map(warrants.map((w, i) => [w.warrantId, i]));

  const [shots, setShots] = useState<Shot[]>([]);
  const geo = useRef({ warrants, gates, ringIndex, radius, rb, motion });
  geo.current = { warrants, gates, ringIndex, radius, rb, motion };
  const timers = useRef<number[]>([]);
  useEffect(() => () => timers.current.forEach((t) => clearTimeout(t)), []);

  usePassStream(passes, !compact && n > 0, (fresh) => {
    if (!geo.current.motion) return;
    fresh.forEach((p, i) => {
      timers.current.push(
        window.setTimeout(() => {
          const shot = trail(p);
          if (shot) setShots((s) => [...s.slice(-11), shot]);
        }, i * 340),
      );
    });
  });

  function trail(p: Pass): Shot | null {
    const g = geo.current;
    const i = g.ringIndex.get(p.warrantId);
    const w = i === undefined ? undefined : g.warrants[i];
    if (i === undefined || !w) return null;
    const r = g.radius(i);
    const share = leftFraction(w.spentCents, w.totalBudget.cents);
    const gate = g.gates.find((x) => x.id === p.payee);
    const portShare = gate?.share ?? share;
    let delta = portShare - share;
    if (delta > 0.5) delta -= 1;
    if (delta < -0.5) delta += 1;
    const tip = at(r, share);
    const port = at(g.rb, portShare);
    const bend = at((r + g.rb) / 2 + 18, share + delta / 2);
    let d = `M${f(tip.x)} ${f(tip.y)} Q${f(bend.x)} ${f(bend.y)} ${f(port.x)} ${f(port.y)}`;
    let end = port;
    if (p.fate === "paid" && gate) {
      d += ` L${f(gate.pos.x)} ${f(gate.pos.y)}`;
      end = gate.pos;
    }
    const color = p.fate === "paid" ? tintOf(i) : p.fate === "blocked" ? RED : AMBER;
    return { key: p.seq, d, color, fate: p.fate, end };
  }

  // One amber light per port, however many payments wait there.
  const waiting = new Map<string, { pt: Pt; n: number }>();
  if (!compact) {
    for (const a of approvals) {
      const payee = field(a.view, "payee.payeeId");
      const wid = field(a.view, "warrant.warrantId");
      const gate = gates.find((g) => g.id === payee);
      const i = typeof wid === "string" ? ringIndex.get(wid) : undefined;
      const w = i === undefined ? undefined : warrants[i];
      const pt = gate
        ? gate.port
        : at(rb, w ? leftFraction(w.spentCents, w.totalBudget.cents) : 0.5);
      const k = `${f(pt.x)},${f(pt.y)}`;
      const hit = waiting.get(k);
      if (hit) hit.n += 1;
      else waiting.set(k, { pt, n: 1 });
    }
  }

  const focus = warrants.find((w) => w.warrantId === selected);

  return (
    <svg
      className={`rings${compact ? " compact" : ""}${stopped ? " is-stopped" : ""}${motion ? " moving" : ""}`}
      viewBox={`${-halfW} ${-half} ${halfW * 2} ${half * 2}`}
      preserveAspectRatio="xMidYMid meet"
      role="img"
      aria-label="Budget left per agent"
      onClick={() => onSelect?.(null)}
    >
      <circle className="rg-floor" r={rb} />
      <circle className="rg-ticks" r={rb + 9} pathLength={120} />
      <circle className="rg-ticks major" r={rb + 11} pathLength={24} />
      <circle className="rg-bound" r={rb} />

      {!compact &&
        gates.map((g) => {
          const paid = paidTo?.get(g.id);
          const side = g.pos.x > 12 ? "start" : g.pos.x < -12 ? "end" : "middle";
          const dx = side === "start" ? 16 : side === "end" ? -16 : 0;
          const dy = side === "middle" ? (g.pos.y < 0 ? -22 : 30) : 4;
          return (
            <g key={g.id} className={`rg-gate${paid ? " paid" : ""}`}>
              <line className="rg-link" x1={g.port.x} y1={g.port.y} x2={g.pos.x} y2={g.pos.y} />
              <circle className="rg-port" cx={g.port.x} cy={g.port.y} r={4} />
              <circle className="rg-node" cx={g.pos.x} cy={g.pos.y} r={8} />
              <text x={g.pos.x + dx} y={g.pos.y + dy} textAnchor={side}>
                <tspan className="rg-name">{g.name}</tspan>
                {paid && (
                  <tspan className="rg-sub" x={g.pos.x + dx} dy={19}>
                    {money(paid)} paid
                  </tspan>
                )}
              </text>
            </g>
          );
        })}

      {warrants.map((w, i) => {
        const r = radius(i);
        const share = leftFraction(w.spentCents, w.totalBudget.cents);
        const dim = selected !== null && selected !== w.warrantId;
        const d = `M0 ${-r} A${r} ${r} 0 1 1 0 ${r} A${r} ${r} 0 1 1 0 ${-r}`;
        // The name sits inside the ring where its arc starts, as on a watch face.
        const label = agentName(w.agentRole).replace(/ agent$/, "");
        const pathId = `rg-path-${w.warrantId}`;
        return (
          <g
            key={w.warrantId}
            className={`rg-ring${dim ? " dim" : ""}${selected === w.warrantId ? " on" : ""}`}
            style={{ color: tintOf(i) }}
          >
            <circle className="rg-track" r={r} strokeWidth={width} />
            <path id={pathId} d={d} fill="none" />
            {share > 0.002 && (
              <path
                className="rg-arc"
                d={d}
                pathLength={100}
                strokeWidth={width}
                style={{ strokeDasharray: `${(share * 100).toFixed(2)} 100` }}
              />
            )}
            <text
              className={`rg-label${share * 2 * Math.PI * r > label.length * 10 + 30 ? " on-arc" : ""}`}
              dominantBaseline="central"
            >
              <textPath href={`#${pathId}`} startOffset={12}>
                {label}
              </textPath>
            </text>
            {onSelect && (
              <circle
                className="rg-hit"
                r={r}
                strokeWidth={gap}
                onClick={(e) => {
                  e.stopPropagation();
                  onSelect(w.warrantId);
                }}
              >
                <title>{agentName(w.agentRole)}</title>
              </circle>
            )}
          </g>
        );
      })}

      {focus && !compact && (
        <text className="rg-centre" textAnchor="middle">
          <tspan x={0} y={-4}>
            {cents(
              Math.max(0, focus.totalBudget.cents - focus.spentCents),
              focus.totalBudget.currency,
            )}
          </tspan>
          <tspan className="rg-centre-k" x={0} dy={22}>
            left of {money(focus.totalBudget)}
          </tspan>
        </text>
      )}

      {[...waiting.values()].map(({ pt, n: count }) => (
        <g key={`${f(pt.x)},${f(pt.y)}`} className="rg-wait">
          <circle className="rg-wait-glow" cx={pt.x} cy={pt.y} r={14} />
          <circle cx={pt.x} cy={pt.y} r={6} />
          {count > 1 && (
            <text x={pt.x} y={pt.y - 20} textAnchor="middle">
              {count}
            </text>
          )}
        </g>
      ))}

      {shots.map((s) => (
        <Trail
          key={s.key}
          shot={s}
          onEnd={() => setShots((all) => all.filter((x) => x.key !== s.key))}
        />
      ))}
    </svg>
  );
}

/** One payment: a short bright segment running along its path, then a ring where it ended. */
function Trail({ shot, onEnd }: { shot: Shot; onEnd: () => void }) {
  const path = useRef<SVGPathElement>(null);
  const head = useRef<SVGCircleElement>(null);
  const [landed, setLanded] = useState(false);
  const done = useRef(onEnd);
  done.current = onEnd;

  useEffect(() => {
    const p = path.current;
    const h = head.current;
    if (!p || !h) return;
    const len = p.getTotalLength();
    const seg = Math.min(70, len * 0.45);
    const start = performance.now();
    let raf = 0;
    let after = 0;
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
      else {
        setLanded(true);
        after = window.setTimeout(() => done.current(), 900);
      }
    };
    raf = requestAnimationFrame(tick);
    return () => {
      cancelAnimationFrame(raf);
      clearTimeout(after);
    };
  }, []);

  return (
    <g className={`rg-trail ${shot.fate}${landed ? " landed" : ""}`} style={{ color: shot.color }}>
      <path ref={path} d={shot.d} />
      <circle ref={head} r={4.5} />
      {landed && <circle className="rg-land" cx={shot.end.x} cy={shot.end.y} r={10} />}
    </g>
  );
}
