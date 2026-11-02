import { useEffect, useMemo, useRef, useState } from "react";
import { usePassStream } from "./usePassStream.js";
import type { LoggedEvent, PendingApproval, WarrantRow } from "../api.js";
import { agentName, cents, money, percentUsed } from "../format.js";
import { OTHER, passesOf, payeeNodes, spread, tally } from "../flow.js";
import type { Fate, Pass } from "../flow.js";

/**
 * The picture the dashboard is built around: agents on the left, the people they pay on the
 * right, and the owner's warrant in the middle as the one gate every payment passes through.
 * Each payment runs along its lane as a dot: green goes through to the payee, red stops dead at
 * the seal, amber waits at the seal for the owner. Lanes thicken with traffic.
 */

const W = 1000;
const H = 340;
const SX = W / 2;
const SY = H / 2;
const R = 64;
const AX = 230;
const PX = 770;
const RUN_MS = 1500;

const COLOR: Record<Fate, string> = {
  paid: "var(--ok)",
  blocked: "var(--stop)",
  asked: "var(--wait)",
};

const inPath = (y: number) =>
  `M${AX + 26},${y} C${AX + 140},${y} ${SX - 170},${SY} ${SX - R},${SY}`;
const outPath = (y: number) =>
  `M${SX + R},${SY} C${SX + 170},${SY} ${PX - 140},${y} ${PX - 10},${y}`;
/** The whole trip for a payment that went through: into the seal, across it, out to the payee. */
const through = (ay: number, py: number) =>
  `${inPath(ay)} L${SX + R},${SY} C${SX + 170},${SY} ${PX - 140},${py} ${PX - 10},${py}`;

const reducedMotion = () =>
  typeof matchMedia !== "undefined" && matchMedia("(prefers-reduced-motion: reduce)").matches;

interface Run {
  key: string;
  d: string;
  fate: Fate;
  delay: number;
}

/** One payment's dot running its lane, with a short comet tail and a burst where it lands. */
function Pulse({ run, onDone }: { run: Run; onDone: (key: string) => void }) {
  const path = useRef<SVGPathElement>(null);
  const dots = useRef<(SVGCircleElement | null)[]>([]);
  const [landed, setLanded] = useState<{ x: number; y: number } | null>(null);

  useEffect(() => {
    const p = path.current;
    if (!p) return;
    const len = p.getTotalLength();
    const dur = reducedMotion() ? 1 : RUN_MS;
    const t0 = performance.now() + run.delay;
    let raf = 0;
    let timer = 0;
    const ease = (t: number) => (t < 0.5 ? 2 * t * t : 1 - (-2 * t + 2) ** 2 / 2);
    const step = (now: number) => {
      const t = Math.min(1, Math.max(0, (now - t0) / dur));
      dots.current.forEach((c, i) => {
        if (!c) return;
        const at = p.getPointAtLength(len * ease(Math.max(0, t - i * 0.025)));
        c.setAttribute("cx", String(at.x));
        c.setAttribute("cy", String(at.y));
        c.style.opacity = now < t0 ? "0" : String(1 - i * 0.28);
      });
      if (t < 1) raf = requestAnimationFrame(step);
      else {
        const end = p.getPointAtLength(len);
        setLanded({ x: end.x, y: end.y });
        timer = window.setTimeout(() => onDone(run.key), 900);
      }
    };
    raf = requestAnimationFrame(step);
    return () => {
      cancelAnimationFrame(raf);
      clearTimeout(timer);
    };
  }, [run, onDone]);

  const color = COLOR[run.fate];
  return (
    <g>
      <path ref={path} d={run.d} fill="none" stroke="none" />
      {!landed &&
        [0, 1, 2].map((i) => (
          <circle
            key={i}
            ref={(el) => {
              dots.current[i] = el;
            }}
            r={6 - i * 1.5}
            fill={color}
            style={{ opacity: 0 }}
          />
        ))}
      {landed && (
        <g>
          <circle
            className="fm-burst"
            cx={landed.x}
            cy={landed.y}
            r={10}
            fill="none"
            stroke={color}
            strokeWidth={2}
          />
          {run.fate === "blocked" && (
            <path
              className="fm-x"
              d={`M${landed.x - 6},${landed.y - 6} l12,12 m0,-12 l-12,12`}
              stroke={color}
              strokeWidth={2.5}
              strokeLinecap="round"
            />
          )}
        </g>
      )}
    </g>
  );
}

export function FlowMap({
  warrants,
  events,
  approvals,
  stopped,
}: {
  warrants: WarrantRow[];
  events: LoggedEvent[];
  approvals: PendingApproval[];
  stopped: boolean;
}) {
  const payees = useMemo(() => payeeNodes(warrants), [warrants]);
  const passes = useMemo(() => passesOf(events, warrants), [events, warrants]);
  const { total, lanes, paidTo } = useMemo(() => tally(passes), [passes]);
  const ay = spread(warrants.length, H, 110);
  const py = spread(payees.length, H, 80);
  const agentY = new Map(warrants.map((w, i) => [w.warrantId, ay[i] ?? SY]));
  const payeeY = new Map(payees.map((p, i) => [p.id, py[i] ?? SY]));

  // New payments become runs; on first paint the last few replay so the map shows motion.
  const [runs, setRuns] = useState<Run[]>([]);
  usePassStream(passes, warrants.length > 0, (fresh) => {
    const toRun = (p: Pass, i: number): Run | null => {
      const a = agentY.get(p.warrantId);
      if (a === undefined) return null;
      const b = payeeY.get(p.payee) ?? payeeY.get(OTHER) ?? SY;
      return {
        key: `r${p.seq}`,
        d: p.fate === "paid" ? through(a, b) : inPath(a),
        fate: p.fate,
        delay: i * 320,
      };
    };
    const add = fresh.map(toRun).filter((r): r is Run => r !== null);
    setRuns((rs) => [...rs, ...add]);
  });
  const done = useMemo(() => (key: string) => setRuns((rs) => rs.filter((r) => r.key !== key)), []);

  const live = !stopped;
  const laneWidth = (n: number) => 1.5 + Math.min(4, n / 3);
  const summary = `${total.paid + total.blocked + total.asked} payments: ${total.paid} paid, ${total.blocked} blocked, ${approvals.length} waiting.`;

  return (
    <section className={`panel flow${stopped ? " is-stopped" : ""}`} aria-label="Payment flow">
      <div className="row">
        <h2 style={{ margin: 0 }}>Payments</h2>
        <span className="spacer" />
        <span className="flow-legend">
          <i style={{ background: "var(--ok)" }} /> paid
          <i style={{ background: "var(--stop)" }} /> blocked
          <i style={{ background: "var(--wait)" }} /> asks you
        </span>
      </div>
      <svg viewBox={`0 0 ${W} ${H}`} role="img" aria-label={summary}>
        <defs>
          <pattern id="fm-dots" width="20" height="20" patternUnits="userSpaceOnUse">
            <circle cx="1" cy="1" r="1" className="fm-grid" />
          </pattern>
          <radialGradient id="fm-glow">
            <stop offset="0%" className="fm-glow-in" />
            <stop offset="100%" className="fm-glow-out" />
          </radialGradient>
        </defs>
        <rect width={W} height={H} fill="url(#fm-dots)" />
        <circle cx={SX} cy={SY} r={R * 2.4} fill="url(#fm-glow)" />

        {/* lanes: agent to seal, seal to payee */}
        {warrants.map((w) => {
          const y = agentY.get(w.warrantId) ?? SY;
          const n = lanes.get(w.warrantId);
          const traffic = n ? n.paid + n.blocked + n.asked : 0;
          return (
            <g key={w.warrantId}>
              <path d={inPath(y)} className="fm-lane" strokeWidth={laneWidth(traffic)} />
              {live && traffic > 0 && <path d={inPath(y)} className="fm-lane-live" />}
            </g>
          );
        })}
        {payees.map((p) => {
          const y = payeeY.get(p.id) ?? SY;
          return (
            <g key={p.id}>
              <path d={outPath(y)} className="fm-lane" strokeWidth={paidTo.has(p.id) ? 3 : 1.5} />
              {live && paidTo.has(p.id) && <path d={outPath(y)} className="fm-lane-live" />}
            </g>
          );
        })}

        {/* the agents, each with a ring showing how much of its budget is used */}
        {warrants.map((w) => {
          const y = agentY.get(w.warrantId) ?? SY;
          const pct = percentUsed(w.spentCents, w.totalBudget.cents);
          const c = 2 * Math.PI * 20;
          const n = lanes.get(w.warrantId) ?? { paid: 0, blocked: 0, asked: 0 };
          return (
            <g key={w.warrantId}>
              <circle cx={AX} cy={y} r={20} className="fm-track" />
              <circle
                cx={AX}
                cy={y}
                r={20}
                fill="none"
                stroke={stopped ? "var(--stop)" : pct >= 80 ? "var(--wait)" : "var(--seal)"}
                strokeWidth={4}
                strokeDasharray={`${(c * pct) / 100} ${c}`}
                transform={`rotate(-90 ${AX} ${y})`}
                strokeLinecap="round"
              />
              <text x={AX} y={y + 4} textAnchor="middle" className="fm-pct">
                {pct}%
              </text>
              <text x={AX - 34} y={y - 8} textAnchor="end" className="fm-name">
                {agentName(w.agentRole)}
              </text>
              <text x={AX - 34} y={y + 9} textAnchor="end" className="fm-sub">
                {cents(Math.max(0, w.totalBudget.cents - w.spentCents), w.totalBudget.currency)}{" "}
                left
              </text>
              <text x={AX - 34} y={y + 24} textAnchor="end" className="fm-tiny">
                {n.paid} paid · {n.blocked} blocked
              </text>
            </g>
          );
        })}

        {/* the payees */}
        {payees.map((p) => {
          const y = payeeY.get(p.id) ?? SY;
          const paid = paidTo.get(p.id);
          return (
            <g key={p.id}>
              <circle
                cx={PX}
                cy={y}
                r={7}
                fill={paid ? "var(--ok)" : "var(--panel)"}
                className="fm-payee"
              />
              <text x={PX + 18} y={y - 2} className="fm-name">
                {p.name}
              </text>
              <text x={PX + 18} y={y + 14} className="fm-sub">
                {paid ? `${money(paid)} paid` : "nothing paid yet"}
              </text>
            </g>
          );
        })}

        {/* the seal: the owner's signed limits */}
        <g className="fm-seal">
          <circle cx={SX} cy={SY} r={R + 22} className="fm-halo" />
          <circle cx={SX} cy={SY} r={R + 11} className="fm-ring fm-ticks" pathLength={120} />
          <circle cx={SX} cy={SY} r={R} className="fm-core" />
          <circle cx={SX} cy={SY} r={R - 7} className="fm-core-in" />
          {stopped ? (
            <text x={SX} y={SY + 7} textAnchor="middle" className="fm-stop-word">
              STOPPED
            </text>
          ) : (
            <>
              <text x={SX} y={SY + 2} textAnchor="middle" className="fm-count">
                {total.paid + total.blocked + total.asked}
              </text>
              <text x={SX} y={SY + 20} textAnchor="middle" className="fm-tiny">
                checked
              </text>
              <text x={SX} y={SY + 34} textAnchor="middle" className="fm-tiny fm-red">
                {total.blocked} blocked
              </text>
            </>
          )}
        </g>

        {/* payments waiting for the owner sit at the gate */}
        {approvals.slice(0, 5).map((a, i) => (
          <circle
            key={a.proposalId}
            cx={SX - R - 34}
            cy={SY - 24 + i * 12}
            r={5}
            className="fm-waiting"
          >
            <title>waiting</title>
          </circle>
        ))}

        {runs.map((r) => (
          <Pulse key={r.key} run={r} onDone={done} />
        ))}
      </svg>
    </section>
  );
}
