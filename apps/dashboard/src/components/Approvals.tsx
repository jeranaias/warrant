import { useEffect, useRef, useState } from "react";
import { api } from "../api.js";
import type { PendingApproval } from "../api.js";
import { agentName, approveLabel, field, isMoney, money, time, viewRows } from "../format.js";

/**
 * "Waiting for you": each card shows every field of the view control stored, and Approve / Deny
 * sends back that view's hash. Never add, hide or reorder-by-meaning fields here: the owner must
 * approve exactly what control will hold them to. Labels live in format.ts (FIELD_LABELS).
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

/** One approval. With `hotkeys`, A approves and D denies. */
export function ApprovalCard({
  a,
  onDone,
  onError,
  hotkeys = false,
}: {
  a: PendingApproval;
  onDone: () => void;
  onError: (e: string) => void;
  hotkeys?: boolean;
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
  return (
    <article className="approval">
      <header className="card-head">
        <span className="badge wait">{isBudget ? "new limits" : "payment"}</span>
        <span className="muted small">asked at {time(a.requestedAt)}</span>
      </header>
      <div className="ask">
        <span className="ask-who">
          {agentName(typeof role === "string" ? role : undefined)}{" "}
          {isBudget ? "proposes new limits" : "wants to pay"}
        </span>
        {isBudget ? (
          <span className="ask-amount">
            {isMoney(newCap) ? `${money(newCap)} a payment` : ""}
            {isMoney(newBudget) && <span className="ask-sub"> · {money(newBudget)} in total</span>}
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
      <table className="kv" aria-label="Details">
        <tbody>
          {viewRows(a.view).map((r) => (
            <tr key={r.key}>
              <th>{r.label}</th>
              <td className={r.key === "amount" ? "strong" : ""}>{r.value}</td>
            </tr>
          ))}
        </tbody>
      </table>
      <footer className="approval-foot">
        <span className="mono muted small" title={a.shownHash}>
          shown {a.shownHash.slice(0, 12)}
        </span>
        <span className="spacer" />
        <button className="btn" disabled={sending} onClick={() => void decide("denied")}>
          Deny{hotkeys && <kbd>D</kbd>}
        </button>
        <button className="btn primary" disabled={sending} onClick={() => void decide("approved")}>
          {isBudget ? "Sign new limits" : approveLabel(a.view)}
          {hotkeys && <kbd>A</kbd>}
        </button>
      </footer>
    </article>
  );
}
