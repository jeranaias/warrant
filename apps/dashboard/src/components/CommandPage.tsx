import { useEffect, useMemo, useRef, useState } from "react";
import type { CSSProperties, ReactNode } from "react";
import type { KillState, LoggedEvent, WarrantRow } from "../api.js";
import { agentName, cents, money, time, whyOf } from "../format.js";
import { OTHER, leftFraction, passesOf, payeeNodes, tally } from "../flow.js";
import type { Fate, Pass, Tally } from "../flow.js";
import { tintOf } from "../tints.js";
import type { useEngine } from "../useEngine.js";
import { Activity } from "./Activity.js";
import { ApprovalCard, keyOf } from "./Approvals.js";
import { Chain } from "./Chain.js";
import { Rings } from "./Rings.js";
import { Scene } from "./Scene.js";
import { StopButton } from "./StopButton.js";

/**
 * The desktop page: the scene fills the window and everything else sits on its edges.
 *
 *   top      name, state, counts, clock
 *   left     agents (click or 1-9 to select)
 *   right    the one thing in focus: the first approval (A / D), else the selected agent,
 *            else the STOP receipt
 *   bottom   drawers (activity, mandates, scenarios), the latest payment, STOP (S, Enter)
 *
 * The rings (Rings.tsx) sit in the space between the side panels.
 */

type Engine = ReturnType<typeof useEngine>;
type Drawer = "activity" | "mandates" | "scenarios";

const FATE_WORD: Record<Fate, string> = { paid: "paid", blocked: "blocked", asked: "waiting" };
const MOTION_KEY = "warrant.motion";

function initialMotion(): boolean {
  try {
    const saved = localStorage.getItem(MOTION_KEY);
    if (saved === "on" || saved === "off") return saved === "on";
  } catch {
    // storage blocked: fall through to the system setting
  }
  return !(
    typeof matchMedia !== "undefined" && matchMedia("(prefers-reduced-motion: reduce)").matches
  );
}

function useUtcClock(): string {
  const [now, setNow] = useState(() => new Date());
  useEffect(() => {
    const t = window.setInterval(() => setNow(new Date()), 1000);
    return () => clearInterval(t);
  }, []);
  return now.toISOString().slice(11, 19);
}

export function CommandPage({
  engine,
  banner,
  onError,
}: {
  engine: Engine;
  banner: ReactNode;
  onError: (e: string) => void;
}) {
  const warrants = useMemo(() => engine.world?.warrants ?? [], [engine.world]);
  const stopped = engine.kill?.engaged ?? false;
  const payees = useMemo(() => payeeNodes(warrants), [warrants]);
  const passes = useMemo(() => passesOf(engine.events, warrants), [engine.events, warrants]);
  const { total, lanes, paidTo } = useMemo(() => tally(passes), [passes]);

  const [selected, setSelected] = useState<string | null>(null);
  const [drawer, setDrawer] = useState<Drawer | null>(null);
  const [motion, setMotion] = useState(initialMotion);
  const clock = useUtcClock();

  useEffect(() => {
    try {
      localStorage.setItem(MOTION_KEY, motion ? "on" : "off");
    } catch {
      // per-viewer convenience only
    }
  }, [motion]);
  useEffect(() => {
    if (selected && !warrants.some((w) => w.warrantId === selected)) setSelected(null);
  }, [selected, warrants]);

  const keys = useRef({ warrants, drawer, selected });
  keys.current = { warrants, drawer, selected };
  useEffect(() => {
    const on = (e: KeyboardEvent) => {
      const k = keyOf(e);
      if (!k) return;
      const { warrants: ws, drawer: d, selected: s } = keys.current;
      if (/^[1-9]$/.test(k)) {
        const w = ws[Number(k) - 1];
        if (w) setSelected(w.warrantId === s ? null : w.warrantId);
      } else if (k === "Escape") {
        if (d) setDrawer(null);
        else setSelected(null);
      } else if (k === "l") setDrawer(d === "activity" ? null : "activity");
      else if (k === "m") setMotion((m) => !m);
    };
    window.addEventListener("keydown", on);
    return () => window.removeEventListener("keydown", on);
  }, []);

  const last = passes[passes.length - 1];
  const lastEvent = last && engine.events.find((e) => e.seq === last.seq);
  const focus = engine.approvals[0];
  const agent = warrants.find((w) => w.warrantId === selected);

  return (
    <div className={`cmdpage${stopped ? " is-stopped" : ""}`}>
      <div
        className={`rings-wrap${engine.approvals.length || selected || (stopped && engine.kill?.last) ? " sheet-open" : ""}`}
      >
        {engine.world && (
          <Rings
            warrants={warrants}
            payees={payees}
            paidTo={paidTo}
            passes={passes}
            approvals={engine.approvals}
            stopped={stopped}
            motion={motion}
            selected={selected}
            onSelect={(id) => setSelected(id === null || id === selected ? null : id)}
          />
        )}
      </div>

      <div className="hud">
        <header className="hud-top">
          <div className="hud-brand">
            <span className="seal-mark" aria-hidden="true">
              W
            </span>
            <span className="hud-name">Warrant</span>
            <span className={`hud-link ${engine.connected ? "on" : ""}`}>
              {engine.connected ? "live" : "connecting"}
            </span>
          </div>
          <StateChip stopped={stopped} waiting={engine.approvals.length} />
          <span className="spacer" />
          <Counts total={total} waiting={engine.approvals.length} />
          <span className="hud-clock mono">{clock} UTC</span>
          <button
            className="hud-btn"
            aria-pressed={motion}
            onClick={() => setMotion((m) => !m)}
            title="Animation"
          >
            Motion {motion ? "on" : "off"}
            <kbd>M</kbd>
          </button>
          <a className="hud-btn" href="#/m">
            Phone
          </a>
        </header>

        {banner && <div className="hud-banner">{banner}</div>}

        <nav className="hud-left" aria-label="Agents">
          <AgentList
            warrants={warrants}
            lanes={lanes}
            selected={selected}
            stopped={stopped}
            onSelect={(id) => setSelected(id === selected ? null : id)}
          />
        </nav>

        <aside className="hud-right" aria-live="polite">
          {stopped && engine.kill?.last ? (
            <StopReceipt kill={engine.kill} />
          ) : focus ? (
            <section className="sheet sheet-wait">
              <div className="sheet-k">
                waiting · {engine.approvals.length > 1 ? `1 of ${engine.approvals.length}` : "1"}
              </div>
              <ApprovalCard
                key={focus.proposalId}
                a={focus}
                onDone={engine.refresh}
                onError={onError}
                hotkeys
              />
            </section>
          ) : agent ? (
            <AgentPanel
              w={agent}
              passes={passes}
              payeeName={(id) => payees.find((p) => p.id === id)?.name ?? "customer"}
              stopped={stopped}
              onClose={() => setSelected(null)}
            />
          ) : null}
        </aside>

        {drawer && (
          <section className="drawer" aria-label={drawer}>
            <button className="drawer-x" onClick={() => setDrawer(null)} aria-label="Close">
              ×
            </button>
            {drawer === "activity" && <Activity events={engine.events} />}
            {drawer === "mandates" &&
              (engine.chain ? <Chain chain={engine.chain} /> : <p className="muted">No chain.</p>)}
            {drawer === "scenarios" && (
              <Scene
                chain={engine.chain}
                warrants={warrants}
                onDone={engine.refresh}
                onError={onError}
              />
            )}
          </section>
        )}

        <footer className="hud-bottom">
          <div className="hud-tabs">
            {(
              [
                ["activity", "Activity", "L"],
                ["mandates", "Mandates", null],
                ["scenarios", "Scenarios", null],
              ] as const
            ).map(([id, label, key]) => (
              <button
                key={id}
                className="hud-btn"
                aria-pressed={drawer === id}
                onClick={() => setDrawer(drawer === id ? null : id)}
              >
                {label}
                {key && <kbd>{key}</kbd>}
              </button>
            ))}
          </div>
          <Ticker
            pass={last}
            event={lastEvent}
            agent={agentName(warrants.find((w) => w.warrantId === last?.warrantId)?.agentRole)}
            payee={
              last
                ? (payees.find((p) => p.id === last.payee)?.name ??
                  (last.payee === OTHER ? "customer" : last.payee))
                : ""
            }
          />
          <StopButton kill={engine.kill} onDone={engine.refresh} onError={onError} hotkeys terse />
        </footer>
      </div>
    </div>
  );
}

function StateChip({ stopped, waiting }: { stopped: boolean; waiting: number }) {
  if (stopped) return <span className="chip stop">stopped</span>;
  if (waiting) return <span className="chip wait">{waiting} waiting</span>;
  return <span className="chip">running</span>;
}

function Counts({ total, waiting }: { total: Tally; waiting: number }) {
  return (
    <dl className="counts">
      <div>
        <dt>paid</dt>
        <dd>{total.paid}</dd>
      </div>
      <div className={total.blocked ? "stop" : ""}>
        <dt>blocked</dt>
        <dd>{total.blocked}</dd>
      </div>
      <div className={waiting ? "wait" : ""}>
        <dt>waiting</dt>
        <dd>{waiting}</dd>
      </div>
    </dl>
  );
}

function AgentList({
  warrants,
  lanes,
  selected,
  stopped,
  onSelect,
}: {
  warrants: WarrantRow[];
  lanes: Map<string, Tally>;
  selected: string | null;
  stopped: boolean;
  onSelect: (id: string) => void;
}) {
  return (
    <section className="rail">
      <div className="sheet-k">agents</div>
      <ul>
        {warrants.map((w, i) => {
          const share = leftFraction(w.spentCents, w.totalBudget.cents);
          const n = lanes.get(w.warrantId) ?? { paid: 0, blocked: 0, asked: 0 };
          const tone = stopped ? "stop" : share < 0.2 ? "wait" : "";
          return (
            <li key={w.warrantId}>
              <button
                className={`agent-row ${tone}`}
                style={{ "--tint": tintOf(i) } as CSSProperties}
                aria-pressed={selected === w.warrantId}
                onClick={() => onSelect(w.warrantId)}
              >
                <span className="agent-top">
                  <span className="agent-name">
                    <span className="agent-dot" aria-hidden="true" />
                    {agentName(w.agentRole)}
                  </span>
                  <kbd>{i + 1}</kbd>
                </span>
                <span className="agent-left mono">
                  {cents(Math.max(0, w.totalBudget.cents - w.spentCents), w.totalBudget.currency)}
                  <span className="muted"> of {money(w.totalBudget)}</span>
                </span>
                <span className="agent-bar" aria-hidden="true">
                  <span style={{ width: `${Math.round(share * 100)}%` }} />
                </span>
                <span className="agent-n mono">
                  {n.paid} paid · {n.blocked} blocked
                </span>
              </button>
            </li>
          );
        })}
      </ul>
    </section>
  );
}

function AgentPanel({
  w,
  passes,
  payeeName,
  stopped,
  onClose,
}: {
  w: WarrantRow;
  passes: Pass[];
  payeeName: (id: string) => string;
  stopped: boolean;
  onClose: () => void;
}) {
  const recent = passes
    .filter((p) => p.warrantId === w.warrantId)
    .slice(-8)
    .reverse();
  const left = Math.max(0, w.totalBudget.cents - w.spentCents);
  return (
    <section className="sheet">
      <header className="sheet-head">
        <div>
          <div className="sheet-k">agent</div>
          <h2 className="sheet-title">{agentName(w.agentRole)}</h2>
        </div>
        <span className={`badge ${stopped ? "stop" : "seal"}`}>
          {stopped ? "stopped" : `warrant v${w.version}`}
        </span>
        <button className="drawer-x" onClick={onClose} aria-label="Close">
          ×
        </button>
      </header>
      <p className="sheet-big mono">
        {cents(left, w.totalBudget.currency)}
        <span className="muted"> left of {money(w.totalBudget)}</span>
      </p>
      <p className="sheet-purpose">{w.purpose}</p>
      <dl className="facts">
        <dt>Most per payment</dt>
        <dd className="num">{money(w.perPaymentCap)}</dd>
        <dt>May pay</dt>
        <dd>{w.payees.map((p) => p.displayName).join(", ") || "customers (refunds only)"}</dd>
        <dt>Rails</dt>
        <dd className="mono">{w.allowedRails.join(", ")}</dd>
        <dt>Warrant</dt>
        <dd className="mono">{w.warrantId}</dd>
      </dl>
      <div className="sheet-k">recent</div>
      {recent.length === 0 ? (
        <p className="muted small">No payments yet.</p>
      ) : (
        <ol className="recent">
          {recent.map((p) => (
            <li key={p.seq}>
              <span className="mono muted">{time(p.at)}</span>
              <span className="recent-to">{payeeName(p.payee)}</span>
              <span className="mono">{money(p.amount)}</span>
              <span className={`fate ${p.fate}`}>{FATE_WORD[p.fate]}</span>
            </li>
          ))}
        </ol>
      )}
    </section>
  );
}

function StopReceipt({ kill }: { kill: KillState }) {
  const r = kill.last;
  if (!r) return null;
  return (
    <section className="sheet sheet-stop" role="status">
      <div className="sheet-k">stopped · {time(r.event.at)}</div>
      <p className="sheet-big mono">{r.durationMs} ms</p>
      <dl className="facts">
        <dt>Warrants revoked</dt>
        <dd className="mono">{r.event.revokedWarrantIds.join(", ") || "none"}</dd>
        <dt>Mandates revoked</dt>
        <dd className="mono">{r.revokedMandates.length}</dd>
        <dt>Reason</dt>
        <dd>{r.event.reason}</dd>
        {r.problems.length > 0 && (
          <>
            <dt>Problems</dt>
            <dd>{r.problems.join("; ")}</dd>
          </>
        )}
      </dl>
    </section>
  );
}

function Ticker({
  pass,
  event,
  agent,
  payee,
}: {
  pass: Pass | undefined;
  event: LoggedEvent | undefined;
  agent: string;
  payee: string;
}) {
  if (!pass) return <div className="ticker muted">No payments yet.</div>;
  const why = event ? whyOf(event.event) : undefined;
  return (
    <div className="ticker" aria-live="polite">
      <span className="mono muted">{time(pass.at)}</span>
      <span className="ticker-who">
        {agent} → {payee}
      </span>
      <span className="mono">{money(pass.amount)}</span>
      <span className={`fate ${pass.fate}`}>{FATE_WORD[pass.fate]}</span>
      {why && <span className="ticker-why">{why}</span>}
    </div>
  );
}
