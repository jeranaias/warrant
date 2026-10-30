import { OwnerApproval } from "@warrant/contracts";
import { canonicalHash } from "../crypto.js";

/**
 * Owner approvals (ADR-007). The owner approves EXACTLY what was shown: control stores the hash of
 * the view it rendered, and at decision time rebuilds the view from current state. The approval
 * counts only if the owner's hash, the stored hash and the rebuilt view's hash all match. Any
 * changed field means the approval is void and control must ask again.
 */

/** What the owner sees for one decision. Plain JSON, so it hashes canonically. */
export type ApprovalView = Record<string, unknown>;

export interface PendingApproval {
  proposalId: string;
  view: ApprovalView;
  shownHash: string;
  /** Why the owner must look (ADR-007 items), shown with the view. */
  reasons: string[];
  requestedAt: string;
}

export type ApprovalOutcome =
  | { ok: true; decision: "approved" | "denied"; pending: PendingApproval }
  | { ok: false; error: string };

export class ApprovalBook {
  private readonly pending = new Map<string, PendingApproval>();
  private readonly decided: OwnerApproval[] = [];

  request(proposalId: string, view: ApprovalView, reasons: string[], now: Date): PendingApproval {
    const p: PendingApproval = {
      proposalId,
      view,
      shownHash: canonicalHash(view),
      reasons,
      requestedAt: now.toISOString(),
    };
    this.pending.set(proposalId, p);
    return p;
  }

  get(proposalId: string): PendingApproval | undefined {
    return this.pending.get(proposalId);
  }

  list(): PendingApproval[] {
    return [...this.pending.values()];
  }

  history(): readonly OwnerApproval[] {
    return this.decided;
  }

  /**
   * Record the owner's decision. `currentView` is the view rebuilt from current state, or
   * undefined when it can no longer be built (e.g. the warrant is gone). A denial needs only a
   * matching hash; an approval also needs the rebuilt view to be unchanged.
   */
  decide(raw: unknown, currentView: ApprovalView | undefined): ApprovalOutcome {
    const parsed = OwnerApproval.safeParse(raw);
    if (!parsed.success) return { ok: false, error: "malformed approval" };
    const a = parsed.data;
    const p = this.pending.get(a.proposalId);
    if (!p) return { ok: false, error: "nothing pending for this proposal" };
    if (a.shownHash !== p.shownHash)
      return { ok: false, error: "approval is for a different view" };
    if (a.decision === "approved" && (!currentView || canonicalHash(currentView) !== p.shownHash)) {
      this.pending.delete(a.proposalId);
      return { ok: false, error: "what was shown has changed; ask again" };
    }
    this.pending.delete(a.proposalId);
    this.decided.push(a);
    return { ok: true, decision: a.decision, pending: p };
  }

  /** Kill switch: drop everything pending. */
  clear(): string[] {
    const ids = [...this.pending.keys()];
    this.pending.clear();
    return ids;
  }
}
