import { useEffect, useRef, useState } from "react";
import { api } from "../api.js";
import type { PendingApproval } from "../api.js";
import { agentName, approveLabel, field, isMoney, money, time, viewRows } from "../format.js";

/**
 * "Waiting for you": each card shows every field of the view control stored, and Approve / Deny
 * sends back that view's hash. Never add, hide or reorder-by-meaning fields here: the owner must
 * approve exactly what control will hold them to. Labels live in format.ts (FIELD_LABELS). The
 * summary and the buttons come first; the full table follows them, always shown, never folded.
 */
export function Approvals({
  approvals,
  onDone,
  onError,
}: {
  approvals: PendingApproval[];
  onDone: () => void;
  onError: (e: string) => void;
}) {
  return (
    <section className={`panel ${approvals.length ? "attention" : ""}`}>
      <h2>Waiting for you ({approvals.length})</h2>
      {approvals.length === 0 ? (
        <p className="muted">Nothing waiting.</p>
      ) : (
        <div className="approval-list">
          {approvals.map((a) => (
            <ApprovalCard key={a.proposalId} a={a} onDone={onDone} onError={onError} />
          ))}
        </div>
      )}
    </section>
  );
}

/** Keys from a keyboard event, unless the owner is typing somewhere. */
export function keyOf(e: KeyboardEvent): string | null {
  const t = e.target as HTMLElement | null;
  if (e.ctrlKey || e.metaKey || e.altKey) return null;
  if (t && (t.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName))) return null;
  return e.key.length === 1 ? e.key.toLowerCase() : e.key;
}

/**
 * One approval. With `hotkeys`, A approves and D denies. `roleOf` names the agent that asked
 * (by agent id), so a budget change one agent asks for on another's warrant says so.
 */
export function ApprovalCard({
  a,
  onDone,
  onError,
  hotkeys = false,
  roleOf,
}: {
  a: PendingApproval;
  onDone: () => void;
  onError: (e: string) => void;
  hotkeys?: boolean;
  roleOf?: (agentId: string) => string | undefined;
}) {
  const [sending, setSending] = useState(false);
  const decideRef = useRef<(d: "approved" | "denied") => Promise<void>>(async () => {});
  const decide = async (d: "approved" | "denied") => {
    setSending(true);
    try {
      const r = await api.decide(a, d);
      if (!r.ok) onError(r.error ?? "the decision did not count");
    } catch (e) {
      onError((e as Error).message);
    } finally {
      setSending(false);
      onDone();
    }
  };
  decideRef.current = decide;
  useEffect(() => {
    if (!hotkeys) return;
    const on = (e: KeyboardEvent) => {
      const k = keyOf(e);
      if (k === "a") void decideRef.current("approved");
      if (k === "d") void decideRef.current("denied");
    };
    window.addEventListener("keydown", on);
    return () => window.removeEventListener("keydown", on);
  }, [hotkeys]);
  const isBudget = a.view["kind"] === "budget_change";
  const amount = field(a.view, "amount");
  const role = field(a.view, "agent.role") ?? field(a.view, "warrant.role");
  const payee =
    field(a.view, "payee.displayName") ??
    (field(a.view, "payee.refundOfOrderId")
      ? `refund of ${String(field(a.view, "payee.refundOfOrderId"))}`
      : field(a.view, "payee.payeeId"));
  const newCap = field(a.view, "to.perPaymentCap");
  const newBudget = field(a.view, "to.totalBudget");
  const oldCap = field(a.view, "from.perPaymentCap");
  const oldBudget = field(a.view, "from.totalBudget");
  const by = field(a.view, "proposedBy");
  const byRole = typeof by === "string" ? roleOf?.(by) : undefined;
  const forName = agentName(typeof role === "string" ? role : undefined);
  const who =
    isBudget && byRole && byRole !== role
      ? `${agentName(byRole)} asks to change the ${forName.toLowerCase()}'s limits`
      : `${forName} ${isBudget ? "asks for new limits" : "wants to pay"}`;
  return (
    <article className="approval">
      <header className="card-head">
        <span className="badge wait">{isBudget ? "new limits" : "payment"}</span>
        <span className="muted small">asked at {time(a.requestedAt)}</span>
      </header>
      <div className="ask">
        <span className="ask-who">{who}</span>
        {isBudget ? (
          <span className="ask-change mono">
            {limitChange("Per payment", oldCap, newCap)}
            {limitChange("In total", oldBudget, newBudget)}
          </span>
        ) : (
          isMoney(amount) && <span className="ask-amount">{money(amount)}</span>
        )}
        {!isBudget && payee !== undefined && <span className="ask-to">to {String(payee)}</span>}
      </div>
      {a.reasons.length > 0 && (
        <div className="why-box">
          <span className="why-k">Reason</span>
          <ul className="reasons">
            {a.reasons.map((r) => (
              <li key={r}>{r}</li>
            ))}
          </ul>
        </div>
      )}
      <footer className="approval-foot">
        <button className="btn primary" disabled={sending} onClick={() => void decide("approved")}>
          {isBudget ? "Sign new limits" : approveLabel(a.view)}
          {hotkeys && <kbd>A</kbd>}
        </button>
        <button className="btn" disabled={sending} onClick={() => void decide("denied")}>
          Deny{hotkeys && <kbd>D</kbd>}
        </button>
        <span
          className="fp mono muted small"
          title={`Your approval is bound to exactly what is shown here (${a.shownHash})`}
        >
          Fingerprint {fingerprint(a.shownHash)}
        </span>
      </footer>
      <table className="kv" aria-label="Everything you sign">
        <tbody>
          {viewRows(a.view).map((r) => (
            <tr key={r.key}>
              <th>{r.label}</th>
              <td className={r.key === "amount" ? "strong" : ""}>{r.value}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </article>
  );
}

/** "6338…5189": enough of the shown-view hash to compare, not enough to clutter. */
function fingerprint(hash: string): string {
  return hash.length > 10 ? `${hash.slice(0, 4)}…${hash.slice(-4)}` : hash;
}

/** "Per payment 0.03 USDZ → 0.02 USDZ", or "In total 10.00 USDZ, unchanged". */
function limitChange(label: string, from: unknown, to: unknown) {
  if (!isMoney(to)) return null;
  const same = isMoney(from) && from.cents === to.cents && from.currency === to.currency;
  return (
    <span>
      {label}{" "}
      {same ? (
        <>
          {money(to)}
          <span className="muted">, unchanged</span>
        </>
      ) : (
        <>
          {isMoney(from) && <span className="muted">{money(from)} → </span>}
          <strong>{money(to)}</strong>
        </>
      )}
    </span>
  );
}
