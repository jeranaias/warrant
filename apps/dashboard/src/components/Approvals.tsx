import { useState } from "react";
import { api } from "../api.js";
import type { PendingApproval } from "../api.js";
import { time, viewRows } from "../format.js";

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
        <p className="muted">Nothing needs you. The agents are inside their warrants.</p>
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

function ApprovalCard({
  a,
  onDone,
  onError,
}: {
  a: PendingApproval;
  onDone: () => void;
  onError: (e: string) => void;
}) {
  const [sending, setSending] = useState(false);
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
  const isBudget = a.view["kind"] === "budget_change";
  return (
    <article className="approval">
      <header className="card-head">
        <span className="badge wait">{isBudget ? "new limits" : "payment"}</span>
        <span className="muted small">asked at {time(a.requestedAt)}</span>
      </header>
      {a.reasons.length > 0 && (
        <ul className="reasons">
          {a.reasons.map((r) => (
            <li key={r}>{r}</li>
          ))}
        </ul>
      )}
      <table className="kv">
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
          Deny
        </button>
        <button className="btn primary" disabled={sending} onClick={() => void decide("approved")}>
          Approve
        </button>
      </footer>
    </article>
  );
}
