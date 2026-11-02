import { useMemo, useState } from "react";
import type { CSSProperties } from "react";
import { isOwner } from "../api.js";
import { agentName, cents, field, foldRepeats, isMoney, money, time } from "../format.js";
import { OTHER, leftFraction, passesOf, payeeNodes, tally } from "../flow.js";
import type { Fate } from "../flow.js";
import { tintOf } from "../tints.js";
import type { EngineState } from "../useEngine.js";
import { ApprovalCard } from "./Approvals.js";
import { FirstRun } from "./FirstRun.js";
import { GateBar } from "./Gate.js";
import { StopButton } from "./StopButton.js";

/**
 * The owner's phone (open the dashboard at #/m): only what needs a thumb.
 *
 *   top      state and counts
 *   gate     paid / waiting / blocked as one bar, the top block reason, budget left per agent
 *   waiting  one approval at a time, big Approve / Deny; the rest queue underneath
 *   recent   the last payments
 *   bottom   STOP, always in reach
 */
const FATE_WORD: Record<Fate, string> = { paid: "paid", blocked: "blocked", asked: "waiting" };

export function Phone({
  engine,
  onDone,
  onError,
}: {
  engine: EngineState;
  onDone: () => void;
  onError: (e: string) => void;
}) {
  const warrants = useMemo(() => engine.world?.warrants ?? [], [engine.world]);
  const stopped = engine.kill?.engaged ?? false;
  const payees = useMemo(() => payeeNodes(warrants), [warrants]);
  const passes = useMemo(() => passesOf(engine.events, warrants), [engine.events, warrants]);
  const { total, lanes } = useMemo(() => tally(passes), [passes]);
  const waiting = engine.approvals;
  const [pick, setPick] = useState<string | null>(null);
  const focus = waiting.find((a) => a.proposalId === pick) ?? waiting[0];
  const rest = waiting.filter((a) => a !== focus);
  // Alike payments in a row (a flood of one offer) fold into one line with "×20".
  const recent = foldRepeats(
    passes,
    (p) =>
      `${p.warrantId}|${p.payee}|${p.amount.currency}${p.amount.cents}|${p.fate}|${p.reason ?? ""}`,
  )
    .slice(-8)
    .reverse();
  // The rest of the queue, alike requests folded into one row ("×12").
  const queue: { first: string; who: string; amount: string; n: number }[] = [];
  for (const a of rest) {
    const amount = field(a.view, "amount");
    const role = field(a.view, "agent.role") ?? field(a.view, "warrant.role");
    const payee = field(a.view, "payee.displayName") ?? field(a.view, "payee.payeeId");
    const who = `${agentName(typeof role === "string" ? role : undefined)}${payee !== undefined ? ` → ${String(payee)}` : ""}`;
    const amt = isMoney(amount) ? money(amount) : "new limits";
    const same = queue.find((q) => q.who === who && q.amount === amt);
    if (same) same.n += 1;
    else queue.push({ first: a.proposalId, who, amount: amt, n: 1 });
  }
  const owner = isOwner();

  const nameOf = (warrantId: string) =>
    agentName(warrants.find((w) => w.warrantId === warrantId)?.agentRole);
  const payeeOf = (id: string) =>
    payees.find((p) => p.id === id)?.name ?? (id === OTHER ? "customer" : id);

  return (
    <div className={`ph${stopped ? " is-stopped" : ""}`}>
      <header className="ph-top">
        <span className="seal-mark" aria-hidden="true">
          W
        </span>
        <span className="ph-name">Warrant</span>
        <span className={`chip ${stopped ? "stop" : waiting.length ? "wait" : ""}`}>
          {stopped ? "stopped" : waiting.length ? `${waiting.length} waiting` : "running"}
        </span>
        <span className="spacer" />
        <a className="ph-desk" href="#/desk">
          Desktop
        </a>
      </header>

      <section className="ph-gauge">
        <GateBar passes={passes} stopped={stopped} />
        <dl className="counts ph-counts">
          <div>
            <dt>paid</dt>
            <dd>{total.paid}</dd>
          </div>
          <div className={total.blocked ? "stop" : ""}>
            <dt>blocked</dt>
            <dd>{total.blocked}</dd>
          </div>
          <div className={waiting.length ? "wait" : ""}>
            <dt>waiting</dt>
            <dd>{waiting.length}</dd>
          </div>
        </dl>
        <ul className="ph-agents">
          {warrants.map((w, i) => {
            const n = lanes.get(w.warrantId) ?? { paid: 0, blocked: 0, asked: 0 };
            return (
              <li key={w.warrantId} style={{ "--tint": tintOf(i) } as CSSProperties}>
                <span className="agent-dot" aria-hidden="true" />
                <span className="ph-agent">{agentName(w.agentRole)}</span>
                <span className="mono">
                  {cents(Math.max(0, w.totalBudget.cents - w.spentCents), w.totalBudget.currency)}
                </span>
                <span className="mono muted ph-n">
                  {Math.round(leftFraction(w.spentCents, w.totalBudget.cents) * 100)}% left ·{" "}
                  {n.paid} paid ·{" "}
                  <span className={n.blocked ? "fate blocked" : ""}>{n.blocked} blocked</span>
                </span>
              </li>
            );
          })}
        </ul>
      </section>

      <FirstRun events={engine.events} stopped={stopped} onDone={onDone} onError={onError} />

      {!owner && (
        <p className="ph-note">
          View only. Open the owner link the engine printed to approve or stop.
        </p>
      )}

      {focus && (
        <section className="ph-wait">
          <div className="sheet-k">
            waiting · {waiting.length > 1 ? `1 of ${waiting.length}` : "1"}
          </div>
          <ApprovalCard key={focus.proposalId} a={focus} onDone={onDone} onError={onError} />
          {queue.length > 0 && (
            <ol className="ph-queue">
              {queue.map((q) => (
                <li key={q.first}>
                  <button onClick={() => setPick(q.first)}>
                    <span className="ph-q-who">{q.who}</span>
                    {q.n > 1 && <span className="ph-q-n mono">×{q.n}</span>}
                    <span className="mono">{q.amount}</span>
                  </button>
                </li>
              ))}
            </ol>
          )}
        </section>
      )}

      <section className="ph-recent">
        <div className="sheet-k">recent</div>
        {recent.length === 0 ? (
          <p className="muted small">No payments yet.</p>
        ) : (
          <ol className="recent">
            {recent.map(({ item: p, n }) => (
              <li key={p.seq}>
                <span className="mono muted">{time(p.at)}</span>
                <span className="recent-to">
                  {nameOf(p.warrantId)} → {payeeOf(p.payee)}
                  {n > 1 && <span className="mono muted"> ×{n}</span>}
                </span>
                <span className="mono">{money(p.amount)}</span>
                <span className={`fate ${p.fate}`}>{FATE_WORD[p.fate]}</span>
              </li>
            ))}
          </ol>
        )}
      </section>

      <footer className="ph-stop">
        <StopButton kill={engine.kill} onDone={onDone} onError={onError} big />
      </footer>
    </div>
  );
}
