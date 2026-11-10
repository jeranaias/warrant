import { useEffect, useMemo, useRef, useState } from "react";
import type { CSSProperties, ReactNode } from "react";
import { HOSTED } from "../api.js";
import type { KillState, LoggedEvent, WarrantRow } from "../api.js";
import bench from "../../../../bench/results.json";
import {
  agentsLine,
  benchLine,
  cents,
  money,
  ownerLine,
  time,
  warrantName,
  whyOf,
} from "../format.js";
import { OTHER, leftFraction, limitRequests, passesOf, payeeNodes, tally } from "../flow.js";
import type { Fate, Pass, Tally } from "../flow.js";
import { sellerMoments } from "../seller.js";
import { tintOf } from "../tints.js";
import type { useEngine } from "../useEngine.js";
import { Activity } from "./Activity.js";
import { ApprovalCard, keyOf } from "./Approvals.js";
import { Chain } from "./Chain.js";
import { DemoLine } from "./DemoLine.js";
import { FirstRun } from "./FirstRun.js";
import { Gate } from "./Gate.js";
import { LiveRuns } from "./LiveRuns.js";
import { Scene } from "./Scene.js";
import { Seller } from "./Seller.js";
import { StopButton } from "./StopButton.js";

/**
 * The desktop page: the scene fills the window and everything else sits on its edges.
 *
 *   top      name, state, counts, clock
 *   left     agents (click or 1-9 to select)
 *   right    the one thing in focus: the first approval (A / D), else the selected agent,
 *            else the STOP receipt
 *   bottom   drawers (activity, mandates, scenarios), the latest payment, STOP (S, Enter), and
 *            one line of benchmark numbers from bench/results.json
 *
 * The gate (Gate.tsx) sits in the space between the side panels.
 */

type Engine = ReturnType<typeof useEngine>;
type Drawer = "activity" | "mandates" | "scenarios" | "live";

/** Committed with the corpus; `pnpm bench` rewrites it and CI fails when it is stale. */
const BENCH_LINE = benchLine(bench);

const FATE_WORD: Record<Fate, string> = {
  paid: "paid",
  pending: "scheduled",
  blocked: "blocked",
  asked: "waiting",
};
const REDUCED = "(prefers-reduced-motion: reduce)";

/** Animation follows the system setting: off when the viewer asks for reduced motion. */
function useMotion(): boolean {
  const [motion, setMotion] = useState(
    () => !(typeof matchMedia !== "undefined" && matchMedia(REDUCED).matches),
  );
  useEffect(() => {
    if (typeof matchMedia === "undefined") return;
    const q = matchMedia(REDUCED);
    const on = () => setMotion(!q.matches);
    q.addEventListener("change", on);
    return () => q.removeEventListener("change", on);
  }, []);
  return motion;
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
  onDesk,
}: {
  engine: Engine;
  banner: ReactNode;
  onError: (e: string) => void;
  /** Back to the decision desk. */
  onDesk: () => void;
}) {
  const warrants = useMemo(() => engine.world?.warrants ?? [], [engine.world]);
  const stopped = engine.kill?.engaged ?? false;
  const payees = useMemo(() => payeeNodes(warrants), [warrants]);
  const passes = useMemo(
    () => passesOf(engine.events, warrants, engine.approvals),
    [engine.events, warrants, engine.approvals],
  );
  const { total, lanes } = useMemo(() => tally(passes), [passes]);

  const [selected, setSelected] = useState<string | null>(null);
  const [drawer, setDrawer] = useState<Drawer | null>(null);
  // The request whose replay the activity drawer shows (null: the whole feed).
  const [replayId, setReplayId] = useState<string | null>(null);
  const [hideWaitFor, setHideWaitFor] = useState<string | null>(null);
  const [hideStopAt, setHideStopAt] = useState<string | null>(null);
  const [hideSellerAt, setHideSellerAt] = useState<number | null>(null);
  const moments = useMemo(() => sellerMoments(engine.events), [engine.events]);
  const lastMomentSeq = moments.at(-1)?.seq ?? 0;
  const motion = useMotion();
  const clock = useUtcClock();

  useEffect(() => {
    if (selected && !warrants.some((w) => w.warrantId === selected)) setSelected(null);
  }, [selected, warrants]);

  const last = passes[passes.length - 1];
  const lastEvent = last && engine.events.find((e) => e.seq === last.seq);
  const focus = engine.approvals[0];
  const agent = warrants.find((w) => w.warrantId === selected);
  const stopAt = stopped ? (engine.kill?.last?.event.at ?? null) : null;
  const showStop = stopAt !== null && hideStopAt !== stopAt;
  const showWait = Boolean(focus && hideWaitFor !== focus.proposalId);
  const showSeller = moments.length > 0 && hideSellerAt !== lastMomentSeq;
  const rightOpen = Boolean(drawer || agent || showStop || showWait || showSeller);

  const keys = useRef({
    warrants,
    drawer,
    selected,
    showStop,
    stopAt,
    showWait,
    focusId: focus?.proposalId ?? null,
    showSeller,
    lastMomentSeq,
  });
  keys.current = {
    warrants,
    drawer,
    selected,
    showStop,
    stopAt,
    showWait,
    focusId: focus?.proposalId ?? null,
    showSeller,
    lastMomentSeq,
  };
  useEffect(() => {
    const on = (e: KeyboardEvent) => {
      const k = keyOf(e);
      if (!k) return;
      const cur = keys.current;
      if (/^[1-9]$/.test(k)) {
        const w = cur.warrants[Number(k) - 1];
        if (w) setSelected(w.warrantId === cur.selected ? null : w.warrantId);
      } else if (k === "Escape") {
        if (cur.drawer) setDrawer(null);
        else if (cur.selected) setSelected(null);
        else if (cur.showStop && cur.stopAt !== null) setHideStopAt(cur.stopAt);
        else if (cur.showWait && cur.focusId) setHideWaitFor(cur.focusId);
        else if (cur.showSeller) setHideSellerAt(cur.lastMomentSeq);
      } else if (k === "l") setDrawer(cur.drawer === "activity" ? null : "activity");
    };
    window.addEventListener("keydown", on);
    return () => window.removeEventListener("keydown", on);
  }, []);

  const roleOfWarrant = (id: string) => warrants.find((w) => w.warrantId === id)?.agentRole;
  const roleOfAgent = (id: string) => warrants.find((w) => w.agentId === id)?.agentRole;
  const owned = ownerLine(engine.events, roleOfWarrant, last?.seq ?? 0);

  return (
    <div className={`cmdpage${stopped ? " is-stopped" : ""}`}>
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
          {BENCH_LINE && <span className="bench-chip mono">{BENCH_LINE}</span>}
          <span className="spacer" />
          {HOSTED && <DemoLine onError={onError} />}
          <Counts total={total} waiting={engine.approvals.length} />
          <span className="hud-clock mono">{clock} UTC</span>
          <button
            className="hud-btn"
            aria-pressed={drawer === "live"}
            onClick={() => {
              setReplayId(null);
              setDrawer(drawer === "live" ? null : "live");
            }}
          >
            Testnet runs
          </button>
          <button className="hud-btn" onClick={onDesk}>
            Desk
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

        <div className={`gate-wrap${rightOpen ? " sheet-open" : ""}`}>
          {engine.world && (
            <Gate
              warrants={warrants}
              passes={passes}
              stopped={stopped}
              motion={motion}
              selected={selected}
              onSelect={(id) => setSelected(id === null || id === selected ? null : id)}
              limits={limitRequests(engine.approvals)}
              onFate={(fate) => {
                const latest = passes.filter((p) => p.fate === fate).at(-1)?.proposalId;
                const id =
                  latest ?? (fate === "asked" ? engine.approvals.at(-1)?.proposalId : undefined);
                if (!id) return;
                setReplayId(id);
                setDrawer("activity");
              }}
            />
          )}
        </div>

        <aside className="hud-right" aria-live="polite">
          {drawer ? (
            <section className="drawer" aria-label={drawer}>
              <button className="drawer-x" onClick={() => setDrawer(null)} aria-label="Close">
                ×
              </button>
              {drawer === "activity" && (
                <Activity
                  events={engine.events}
                  warrants={warrants}
                  open={replayId}
                  onOpen={setReplayId}
                />
              )}
              {drawer === "mandates" &&
                (engine.chain ? (
                  <Chain chain={engine.chain} />
                ) : (
                  <p className="muted">No chain.</p>
                ))}
              {drawer === "scenarios" && (
                <Scene
                  chain={engine.chain}
                  warrants={warrants}
                  onDone={engine.refresh}
                  onError={onError}
                />
              )}
              {drawer === "live" && <LiveRuns />}
            </section>
          ) : agent ? (
            <AgentPanel
              w={agent}
              passes={passes}
              payeeName={(id) => payees.find((p) => p.id === id)?.name ?? "customer"}
              stopped={stopped}
              onClose={() => setSelected(null)}
            />
          ) : showStop && engine.kill ? (
            <StopReceipt
              kill={engine.kill}
              roleOf={roleOfWarrant}
              onClose={() => setHideStopAt(stopAt)}
            />
          ) : showWait && focus ? (
            <section className="sheet sheet-wait">
              <div className="sheet-head">
                <div className="sheet-k">
                  waiting · {engine.approvals.length > 1 ? `1 of ${engine.approvals.length}` : "1"}
                </div>
                <button
                  className="drawer-x"
                  onClick={() => setHideWaitFor(focus.proposalId)}
                  aria-label="Close"
                >
                  ×
                </button>
              </div>
              <ApprovalCard
                key={focus.proposalId}
                a={focus}
                onDone={engine.refresh}
                onError={onError}
                hotkeys
                roleOf={roleOfAgent}
              />
            </section>
          ) : showSeller ? (
            <Seller events={engine.events} onClose={() => setHideSellerAt(lastMomentSeq)} />
          ) : null}
        </aside>

        {!drawer && (
          <FirstRun
            events={engine.events}
            stopped={stopped}
            onDone={engine.refresh}
            onError={onError}
          />
        )}

        <footer className="hud-bottom">
          <div className="hud-tabs">
            {(
              [
                ["activity", "Activity", "L"],
                ["mandates", "Mandates", null],
                ["scenarios", "Scenarios", null],
                ["live", "Testnet runs", null],
              ] as const
            ).map(([id, label, key]) => (
              <button
                key={id}
                className="hud-btn"
                aria-pressed={drawer === id}
                onClick={() => {
                  setReplayId(null);
                  setDrawer(drawer === id ? null : id);
                }}
              >
                {label}
                {key && <kbd>{key}</kbd>}
              </button>
            ))}
          </div>
          <Ticker
            owner={owned}
            pass={last}
            event={lastEvent}
            agent={warrantName(
              last?.warrantId,
              warrants.find((w) => w.warrantId === last?.warrantId)?.agentRole,
            )}
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
                    {warrantName(w.warrantId, w.agentRole)}
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
          <h2 className="sheet-title">{warrantName(w.warrantId, w.agentRole)}</h2>
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

export function StopReceipt({
  kill,
  roleOf,
  onClose,
}: {
  kill: KillState;
  roleOf: (warrantId: string) => string | undefined;
  onClose?: () => void;
}) {
  const r = kill.last;
  if (!r) return null;
  return (
    <section className="sheet sheet-stop" role="status">
      <div className="sheet-head">
        <div className="sheet-k">stopped · {time(r.event.at)}</div>
        {onClose && (
          <button className="drawer-x" onClick={onClose} aria-label="Close">
            ×
          </button>
        )}
      </div>
      <p className="sheet-big mono">
        <span className="muted">Stopped in </span>
        {r.durationMs} ms
      </p>
      <dl className="facts">
        <dt>Warrants revoked</dt>
        <dd>{agentsLine(r.event.revokedWarrantIds.map(roleOf)) || "none"}</dd>
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
  owner,
  pass,
  event,
  agent,
  payee,
}: {
  /** The owner's latest action, when it came after the latest payment. */
  owner: string | null;
  pass: Pass | undefined;
  event: LoggedEvent | undefined;
  agent: string;
  payee: string;
}) {
  if (owner)
    return (
      <div className="ticker" aria-live="polite">
        <span className="ticker-who">{owner}</span>
      </div>
    );
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
