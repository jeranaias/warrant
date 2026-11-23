import { useEffect, useMemo, useRef, useState } from "react";
import type { CSSProperties, ReactNode } from "react";
import { HOSTED, api, isOwner } from "../api.js";
import type { PendingApproval, WarrantRow } from "../api.js";
import bench from "../../../../bench/results.json";
import {
  FILTERS,
  askGroups,
  blockedKinds,
  deskRows,
  filterCounts,
  filterRows,
  paySentence,
  payeeName,
} from "../desk.js";
import type { AskGroup, DeskFilter, DeskRow, PayRow } from "../desk.js";
import { OTHER, leftFraction, passesOf } from "../flow.js";
import { benchLine, cents, money, namesOf, time, warrantName } from "../format.js";
import { sellerMoments } from "../seller.js";
import { tintOf } from "../tints.js";
import type { useEngine } from "../useEngine.js";
import { Activity } from "./Activity.js";
import { ApprovalCard, keyOf } from "./Approvals.js";
import { Chain } from "./Chain.js";
import { StopReceipt } from "./CommandPage.js";
import { DemoLine } from "./DemoLine.js";
import { FirstRun } from "./FirstRun.js";
import { LiveRuns } from "./LiveRuns.js";
import { Scene } from "./Scene.js";
import { Replay } from "./Replay.js";
import { Moment } from "./Seller.js";
import { StopButton } from "./StopButton.js";

/**
 * The decision desk: an inbox of what the agents did with their warrants, newest first.
 *
 *   left     filters with counts, budget left per agent, the other pages, STOP
 *   middle   "Needs you" (held requests, alike ones grouped), then paid and blocked sentences
 *            with the reason, alike rows folded ("× 21"), and our store's moments
 *   right    the selected line: a held request's card (A / D), a payment's facts and its replay
 *            (Replay.tsx), a store moment; the STOP receipt once stopped
 *
 * On a narrow screen it is one column: held requests first, rows open in place, STOP at the
 * bottom. The Flow toggle switches to the gate (CommandPage / Phone).
 *
 * A group of held requests offers Deny all, never Approve all: each approval is bound to the
 * one view the owner saw (ADR-013), and a group shows one view. Denying moves no money.
 */

type Engine = ReturnType<typeof useEngine>;
type Page = "activity" | "mandates" | "scenarios" | "live";
type Pick = { kind: "ask" | "row"; key: string } | null;

const PAGES: { id: Page; label: string }[] = [
  { id: "activity", label: "Activity" },
  { id: "mandates", label: "Mandates" },
  { id: "scenarios", label: "Scenarios" },
  { id: "live", label: "Testnet runs" },
];

/** Committed with the corpus; `pnpm bench` rewrites it and CI fails when it is stale. */
const BENCH_LINE = benchLine(bench);

export function Desk({
  engine,
  banner,
  narrow,
  onError,
  onFlow,
}: {
  engine: Engine;
  banner: ReactNode;
  narrow: boolean;
  onError: (e: string) => void;
  onFlow: () => void;
}) {
  const warrants = useMemo(() => engine.world?.warrants ?? [], [engine.world]);
  const stopped = engine.kill?.engaged ?? false;
  const passes = useMemo(
    () => passesOf(engine.events, warrants, engine.approvals),
    [engine.events, warrants, engine.approvals],
  );
  const moments = useMemo(() => sellerMoments(engine.events), [engine.events]);
  const nameOf = (id: string) =>
    warrantName(id, warrants.find((w) => w.warrantId === id)?.agentRole);
  const payeeOf = (id: string) => payeeName(id, warrants);
  const roleOfAgent = (id: string) => warrants.find((w) => w.agentId === id)?.agentRole;
  const roleOfWarrant = (id: string) => warrants.find((w) => w.warrantId === id)?.agentRole;

  const rows = deskRows(passes, moments, nameOf, payeeOf);
  const asks = askGroups(engine.approvals, roleOfAgent);
  const counts = filterCounts(rows);
  const kinds = blockedKinds(rows);
  const countText = (id: DeskFilter) =>
    id === "blocked" && kinds > 0
      ? `${counts[id]} · ${kinds} ${kinds === 1 ? "kind" : "kinds"}`
      : String(counts[id]);
  const [filter, setFilter] = useState<DeskFilter>("all");
  const [page, setPage] = useState<Page | null>(null);
  const [pick, setPick] = useState<Pick>(null);
  const [hideAskKey, setHideAskKey] = useState<string | null>(null);
  const [hideStopAt, setHideStopAt] = useState<string | null>(null);
  const names = useMemo(() => namesOf(engine.events, warrants), [engine.events, warrants]);
  const choose = (next: Pick) => {
    setPick(next);
    if (next?.kind === "ask") setHideAskKey(null);
  };
  // Every request line opens on its replay (Replay.tsx); a folded line shows its latest.
  const steps = (proposalId: string, latest = false) => (
    <div className="desk-steps">
      <div className="sheet-k">step by step{latest ? " · latest" : ""}</div>
      <Replay proposalId={proposalId} names={names} version={engine.events.length} />
    </div>
  );
  const detailOf = (r: DeskRow) => <RowDetail r={r} steps={steps} onClose={() => choose(null)} />;
  const shown = filterRows(rows, filter);

  const pickedAsk = pick?.kind === "ask" ? asks.find((g) => g.key === pick.key) : undefined;
  const pickedRow = pick?.kind === "row" ? rows.find((r) => r.key === pick.key) : undefined;
  // A held request comes first unless the owner picked something else; once one is decided the
  // next one takes its place.
  const defaultAsk = asks[0] && hideAskKey !== asks[0].key ? asks[0] : undefined;
  const ask = pickedAsk ?? (pickedRow ? undefined : defaultAsk);
  // On a narrow screen held requests stay on top whatever row is open below them.
  const topAsk = pickedAsk ?? asks[0];
  const stopAt = stopped ? (engine.kill?.last?.event.at ?? null) : null;
  const receipt =
    stopAt !== null && hideStopAt !== stopAt && engine.kill?.last ? engine.kill : null;
  const owner = isOwner();

  const keys = useRef({ page, pick, askKey: ask?.key ?? null, stopAt: receipt ? stopAt : null });
  keys.current = { page, pick, askKey: ask?.key ?? null, stopAt: receipt ? stopAt : null };
  useEffect(() => {
    const on = (e: KeyboardEvent) => {
      if (keyOf(e) !== "Escape") return;
      const cur = keys.current;
      if (cur.page) setPage(null);
      else if (cur.pick) setPick(null);
      else if (cur.askKey) setHideAskKey(cur.askKey);
      else if (cur.stopAt !== null) setHideStopAt(cur.stopAt);
    };
    window.addEventListener("keydown", on);
    return () => window.removeEventListener("keydown", on);
  }, []);

  const top = (
    <header className="desk-top">
      <span className="seal-mark" aria-hidden="true">
        W
      </span>
      <span className="desk-name">Warrant</span>
      <StateChip stopped={stopped} waiting={engine.approvals.length} />
      <span className={`desk-link ${engine.connected ? "on" : ""}`}>
        {engine.connected ? "connected" : "connecting"}
      </span>
      {BENCH_LINE && <span className="bench-chip mono">{BENCH_LINE}</span>}
      <span className="spacer" />
      {HOSTED && !narrow && <DemoLine onError={onError} />}
      <button
        className="desk-btn"
        aria-pressed={page === "live"}
        onClick={() => setPage(page === "live" ? null : "live")}
      >
        Testnet runs
      </button>
      <button className="desk-btn" onClick={onFlow} title="Show the gate view">
        Flow
      </button>
      <a className="desk-btn" href={narrow ? "#/desk" : "#/m"}>
        {narrow ? "Desktop" : "Phone"}
      </a>
    </header>
  );

  const pageView = page && (
    <section className="desk-page" aria-label={PAGES.find((p) => p.id === page)?.label}>
      <button className="drawer-x desk-page-x" onClick={() => setPage(null)} aria-label="Close">
        ×
      </button>
      {page === "activity" && <Activity events={engine.events} warrants={warrants} />}
      {page === "mandates" &&
        (engine.chain ? <Chain chain={engine.chain} /> : <p className="muted">No chain.</p>)}
      {page === "scenarios" && (
        <Scene chain={engine.chain} warrants={warrants} onDone={engine.refresh} onError={onError} />
      )}
      {page === "live" && <LiveRuns />}
    </section>
  );

  const firstRun = (
    <FirstRun events={engine.events} stopped={stopped} onDone={engine.refresh} onError={onError} />
  );
  const viewOnly = !owner && (
    <p className="desk-note">
      View only. Open the owner link the engine printed to approve or stop.
    </p>
  );

  if (narrow) {
    return (
      <div className={`desk narrow${stopped ? " is-stopped" : ""}`}>
        {top}
        {banner}
        {HOSTED && (
          <p className="desk-demo">
            <DemoLine onError={onError} />
          </p>
        )}
        {pageView}
        {receipt && <StopReceipt kill={receipt} roleOf={roleOfWarrant} />}
        {topAsk && (
          <AskDetail
            key={topAsk.key}
            g={topAsk}
            onDone={engine.refresh}
            onError={onError}
            roleOf={roleOfAgent}
            steps={steps}
          />
        )}
        {asks.length > 1 && (
          <AskList
            asks={asks}
            current={topAsk?.key}
            onPick={(key) => choose({ kind: "ask", key })}
          />
        )}
        {viewOnly}
        {firstRun}
        <div className="desk-chips" role="tablist" aria-label="Show">
          {FILTERS.map((f) => (
            <button
              key={f.id}
              className="chip"
              role="tab"
              aria-selected={filter === f.id}
              onClick={() => setFilter(f.id)}
            >
              {f.label} <span className="mono">{countText(f.id)}</span>
            </button>
          ))}
        </div>
        <RowList
          rows={shown}
          empty={rows.length === 0}
          picked={pick?.kind === "row" ? pick.key : undefined}
          onPick={(key) => choose(pick?.key === key ? null : { kind: "row", key })}
          inline={detailOf}
        />
        <Budgets warrants={warrants} stopped={stopped} />
        <footer className="desk-stop">
          <StopButton kill={engine.kill} onDone={engine.refresh} onError={onError} big />
        </footer>
      </div>
    );
  }

  return (
    <div className={`desk${stopped ? " is-stopped" : ""}${page === "live" ? " wide-page" : ""}`}>
      {top}
      {banner && <div className="desk-banner">{banner}</div>}

      <nav className="desk-nav" aria-label="Desk">
        <ul className="desk-filters">
          <li>
            <button
              className={`desk-filter ${asks.length ? "wait" : ""}`}
              aria-pressed={!page && !!ask}
              disabled={asks.length === 0}
              onClick={() => {
                setPage(null);
                choose(asks[0] ? { kind: "ask", key: asks[0].key } : null);
              }}
            >
              Needs you <span className="mono">{engine.approvals.length}</span>
            </button>
          </li>
          {FILTERS.map((f) => (
            <li key={f.id}>
              <button
                className="desk-filter"
                aria-pressed={!page && filter === f.id}
                onClick={() => {
                  setPage(null);
                  setFilter(f.id);
                }}
              >
                {f.label} <span className="mono">{countText(f.id)}</span>
              </button>
            </li>
          ))}
        </ul>
        <div className="desk-k">budget left</div>
        <Budgets warrants={warrants} stopped={stopped} />
        <div className="desk-k">more</div>
        <ul className="desk-filters">
          {PAGES.map((p) => (
            <li key={p.id}>
              <button
                className="desk-filter"
                aria-pressed={page === p.id}
                onClick={() => setPage(page === p.id ? null : p.id)}
              >
                {p.label}
              </button>
            </li>
          ))}
        </ul>
        <span className="spacer" />
        <StopButton kill={engine.kill} onDone={engine.refresh} onError={onError} hotkeys terse />
      </nav>

      <main className="desk-list">
        {pageView ?? (
          <>
            {firstRun}
            {viewOnly}
            {asks.length > 0 && (
              <section aria-label="Needs you">
                <div className="desk-k wait">needs you</div>
                <AskList
                  asks={asks}
                  current={ask?.key}
                  onPick={(key) => choose({ kind: "ask", key })}
                />
              </section>
            )}
            <div className="desk-k">{FILTERS.find((f) => f.id === filter)?.label}</div>
            <RowList
              rows={shown}
              empty={rows.length === 0}
              picked={pickedRow?.key}
              onPick={(key) => choose({ kind: "row", key })}
            />
          </>
        )}
      </main>

      <aside className="desk-detail" aria-live="polite">
        {receipt && !pickedRow ? (
          <StopReceipt
            kill={receipt}
            roleOf={roleOfWarrant}
            onClose={() => setHideStopAt(stopAt)}
          />
        ) : ask ? (
          <AskDetail
            key={ask.key}
            g={ask}
            onDone={engine.refresh}
            onError={onError}
            roleOf={roleOfAgent}
            steps={steps}
            hotkeys
            onClose={() => {
              setPick(null);
              setHideAskKey(ask.key);
            }}
          />
        ) : pickedRow ? (
          detailOf(pickedRow)
        ) : (
          <p className="desk-empty muted">
            {rows.length ? "Pick a line to see its details." : "Nothing has happened yet."}
          </p>
        )}
      </aside>
    </div>
  );
}

function StateChip({ stopped, waiting }: { stopped: boolean; waiting: number }) {
  if (stopped) return <span className="chip stop">stopped</span>;
  if (waiting) return <span className="chip wait">{waiting} waiting</span>;
  return <span className="chip">running</span>;
}

function Budgets({ warrants, stopped }: { warrants: WarrantRow[]; stopped: boolean }) {
  return (
    <ul className="desk-budgets">
      {warrants.map((w, i) => {
        const share = leftFraction(w.spentCents, w.totalBudget.cents);
        const tone = stopped ? "stop" : share < 0.2 ? "wait" : "";
        return (
          <li key={w.warrantId} className={tone} style={{ "--tint": tintOf(i) } as CSSProperties}>
            <span className="desk-budget-name">{warrantName(w.warrantId, w.agentRole)}</span>
            <span className="mono">
              {cents(Math.max(0, w.totalBudget.cents - w.spentCents), w.totalBudget.currency)}
            </span>
            <span className="desk-bar" aria-hidden="true">
              <span style={{ width: `${Math.round(share * 100)}%` }} />
            </span>
          </li>
        );
      })}
    </ul>
  );
}

function AskList({
  asks,
  current,
  onPick,
}: {
  asks: AskGroup[];
  current: string | undefined;
  onPick: (key: string) => void;
}) {
  return (
    <ol className="desk-rows">
      {asks.map((g) => (
        <li key={g.key}>
          <button
            className="desk-row wait"
            aria-pressed={g.key === current}
            onClick={() => onPick(g.key)}
          >
            <span className="desk-dot" aria-hidden="true" />
            <span className="desk-row-main">
              <span className="desk-row-text">
                {g.title}
                {g.amount && <span className="mono"> · {g.amount}</span>}
              </span>
              {g.why && <span className="desk-row-why">{g.why}</span>}
            </span>
            <span className="desk-row-side">
              {g.items.length > 1 && <span className="desk-n mono">× {g.items.length}</span>}
              <span className="mono muted">{time(g.items[0]?.requestedAt ?? "")}</span>
            </span>
          </button>
        </li>
      ))}
    </ol>
  );
}

function RowList({
  rows,
  empty,
  picked,
  onPick,
  inline,
}: {
  rows: DeskRow[];
  empty: boolean;
  picked: string | undefined;
  onPick: (key: string) => void;
  /** On a narrow screen the picked row opens in place. */
  inline?: (r: DeskRow) => ReactNode;
}) {
  // Lines that arrive while the list is open get a short pulse; the first render has none.
  const seen = useRef<Set<string> | null>(null);
  const first = seen.current === null;
  const known = (seen.current ??= new Set());
  const fresh = new Set(first ? [] : rows.filter((r) => !known.has(r.key)).map((r) => r.key));
  for (const r of rows) known.add(r.key);
  if (rows.length === 0)
    return (
      <p className="desk-empty muted">
        {empty ? "No payments yet. Run a scenario to start." : "Nothing here."}
      </p>
    );
  return (
    <ol className="desk-rows">
      {rows.map((r) => (
        <li key={r.key} className={fresh.has(r.key) ? "fresh" : undefined}>
          <button
            className={`desk-row ${r.kind === "pay" ? r.fate : r.moment.ok ? "store" : "blocked"}`}
            aria-pressed={r.key === picked}
            onClick={() => onPick(r.key)}
          >
            <span className="desk-dot" aria-hidden="true" />
            <span className="desk-row-main">
              {r.kind === "pay" ? (
                <>
                  <span className="desk-row-text">{paySentence({ ...r, n: 1 }, false)}</span>
                  {r.reason && <span className="desk-row-why">{r.reason}</span>}
                </>
              ) : (
                <>
                  <span className="desk-row-text">At our store: {r.moment.title}</span>
                  <span className="desk-row-why">{r.moment.summary}</span>
                </>
              )}
            </span>
            <span className="desk-row-side">
              {r.kind === "pay" && r.n > 1 && <span className="desk-n mono">× {r.n}</span>}
              <span className="mono muted">{time(r.at)}</span>
            </span>
          </button>
          {inline && r.key === picked && <div className="desk-inline">{inline(r)}</div>}
        </li>
      ))}
    </ol>
  );
}

function AskDetail({
  g,
  onDone,
  onError,
  roleOf,
  steps,
  hotkeys = false,
  onClose,
}: {
  g: AskGroup;
  onDone: () => void;
  onError: (e: string) => void;
  roleOf: (agentId: string) => string | undefined;
  steps: Steps;
  hotkeys?: boolean;
  onClose?: () => void;
}) {
  const [first] = g.items;
  if (!first) return null;
  const n = g.items.length;
  return (
    <section className="sheet sheet-wait desk-sheet">
      <div className="sheet-head">
        <div className="sheet-k">waiting{n > 1 ? ` · 1 of ${n} alike` : ""}</div>
        {onClose && (
          <button className="drawer-x" onClick={onClose} aria-label="Close">
            ×
          </button>
        )}
      </div>
      <ApprovalCard
        key={first.proposalId}
        a={first}
        onDone={onDone}
        onError={onError}
        hotkeys={hotkeys}
        roleOf={roleOf}
      />
      {n > 1 && <DenyAll items={g.items} onDone={onDone} onError={onError} />}
      {steps(first.proposalId)}
    </section>
  );
}

/**
 * Deny every request in a group, each with its own hash. One click, then one confirm. There is
 * no Approve all: an approval is bound to the view shown, and only the first one is shown.
 */
function DenyAll({
  items,
  onDone,
  onError,
}: {
  items: PendingApproval[];
  onDone: () => void;
  onError: (e: string) => void;
}) {
  const [arming, setArming] = useState(false);
  const [sending, setSending] = useState(false);
  const run = async () => {
    setArming(false);
    setSending(true);
    try {
      for (const a of items) {
        const r = await api.decide(a, "denied");
        if (!r.ok) {
          onError(r.error ?? "a denial did not count");
          break;
        }
      }
    } catch (e) {
      onError((e as Error).message);
    } finally {
      setSending(false);
      onDone();
    }
  };
  return (
    <div className="desk-bulk">
      {arming ? (
        <>
          <span>Deny all {items.length}?</span>
          <button className="btn" disabled={sending} onClick={() => void run()}>
            Yes, deny {items.length}
          </button>
          <button className="btn link" onClick={() => setArming(false)}>
            Cancel
          </button>
        </>
      ) : (
        <>
          <button className="btn" disabled={sending} onClick={() => setArming(true)}>
            Deny all {items.length}
          </button>
          <span className="muted small">
            Approve one at a time: each approval signs what it shows.
          </span>
        </>
      )}
    </div>
  );
}

type Steps = (proposalId: string, latest?: boolean) => ReactNode;

function RowDetail({
  r,
  steps,
  onClose,
}: {
  r: DeskRow;
  steps: Steps;
  onClose?: (() => void) | undefined;
}) {
  if (r.kind === "store")
    return (
      <section className="sheet sheet-seller desk-sheet">
        <div className="sheet-head">
          <div className="sheet-k">at our store</div>
          {onClose && (
            <button className="drawer-x" onClick={onClose} aria-label="Close">
              ×
            </button>
          )}
        </div>
        <Moment m={r.moment} />
      </section>
    );
  return <PayDetail r={r} steps={steps} onClose={onClose} />;
}

function PayDetail({
  r,
  steps,
  onClose,
}: {
  r: PayRow;
  steps: Steps;
  onClose?: (() => void) | undefined;
}) {
  return (
    <section
      className={`sheet desk-sheet ${r.fate === "blocked" ? "sheet-stop" : r.fate === "pending" ? "sheet-wait" : ""}`}
    >
      <div className="sheet-head">
        <div className="sheet-k">
          {r.fate}
          {r.n > 1 ? ` · ${r.n} alike` : ""}
        </div>
        {onClose && (
          <button className="drawer-x" onClick={onClose} aria-label="Close">
            ×
          </button>
        )}
      </div>
      <p className="desk-sentence">{paySentence(r, !r.reason)}</p>
      {r.reason && (
        <div className="why-box">
          <span className="why-k">{r.fate === "pending" ? "Status" : "Reason"}</span>
          <span>{r.reason}</span>
        </div>
      )}
      <dl className="facts">
        <dt>Agent</dt>
        <dd>{r.who}</dd>
        <dt>To</dt>
        <dd title={r.payeeId === OTHER ? undefined : r.payeeId}>{r.to}</dd>
        <dt>Amount</dt>
        <dd className="num">{money(r.amount)}</dd>
        {r.n > 1 && (
          <>
            <dt>Times</dt>
            <dd className="num">{r.n}</dd>
          </>
        )}
        <dt>{r.n > 1 ? "Latest" : "When"}</dt>
        <dd className="num">{time(r.at)}</dd>
      </dl>
      {r.payeeId !== OTHER && r.payeeId !== r.to && (
        <details className="approval-tech">
          <summary>Technical details</summary>
          <dl className="facts">
            <dt>Payee</dt>
            <dd className="mono">{r.payeeId}</dd>
          </dl>
        </details>
      )}
      {steps(r.proposalId, r.n > 1)}
    </section>
  );
}
