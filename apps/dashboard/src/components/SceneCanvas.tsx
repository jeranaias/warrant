import { useEffect, useRef } from "react";
import type { PendingApproval, WarrantRow } from "../api.js";
import { field, money } from "../format.js";
import { leftFraction } from "../flow.js";
import type { Pass } from "../flow.js";
import { createScene } from "./core-scene.js";
import type { SceneHandle } from "./core-scene.js";
import { usePassStream } from "./usePassStream.js";

/**
 * The scene behind the whole page (core-scene.ts). Loaded lazily: three.js is large, and the
 * instruments on the page's edges must work before it arrives.
 */
export default function SceneCanvas({
  warrants,
  payees,
  paidTo,
  passes,
  approvals,
  stopped,
  motion,
  selected,
  sheetOpen,
  onSelect,
}: {
  warrants: WarrantRow[];
  payees: { id: string; name: string }[];
  paidTo: Map<string, { currency: WarrantRow["totalBudget"]["currency"]; cents: number }>;
  passes: Pass[];
  approvals: PendingApproval[];
  stopped: boolean;
  motion: boolean;
  selected: string | null;
  sheetOpen: boolean;
  onSelect: (warrantId: string | null) => void;
}) {
  const stage = useRef<HTMLDivElement>(null);
  const labels = useRef<HTMLDivElement>(null);
  const scene = useRef<SceneHandle | null>(null);
  const select = useRef(onSelect);
  select.current = onSelect;

  useEffect(() => {
    if (!stage.current || !labels.current) return;
    const s = createScene(stage.current, labels.current, (id) => select.current(id));
    scene.current = s;
    return () => {
      s.dispose();
      scene.current = null;
    };
  }, []);

  useEffect(() => {
    scene.current?.setNodes(
      warrants.map((w) => ({
        id: w.warrantId,
        name: shortName(w.agentRole),
        left: leftFraction(w.spentCents, w.totalBudget.cents),
      })),
      payees.map((p) => {
        const paid = paidTo.get(p.id);
        return { id: p.id, name: p.name, sub: paid ? money(paid) : "", paid: !!paid };
      }),
    );
  }, [warrants, payees, paidTo]);

  useEffect(() => scene.current?.setStopped(stopped), [stopped]);
  useEffect(() => scene.current?.setMotion(motion), [motion]);
  // Matches the side panels in styles.css (.hud columns): agents left, the sheet right.
  useEffect(() => scene.current?.setInsets(300, sheetOpen ? 420 : 0), [sheetOpen]);
  useEffect(() => scene.current?.setSelected(selected), [selected]);
  useEffect(() => {
    scene.current?.setWaiting(
      approvals.map((a) => {
        const payee = field(a.view, "payee.payeeId");
        const warrant = field(a.view, "warrant.warrantId");
        return {
          id: a.proposalId,
          warrantId: typeof warrant === "string" ? warrant : undefined,
          payee: typeof payee === "string" ? payee : undefined,
        };
      }),
    );
  }, [approvals, warrants]);

  usePassStream(passes, warrants.length > 0, (fresh) =>
    fresh.forEach((p, i) =>
      scene.current?.fire(
        { warrantId: p.warrantId, payee: p.payee, fate: p.fate, seq: p.seq },
        i * 340,
      ),
    ),
  );

  return (
    <>
      <div className="scene-stage" ref={stage} />
      <div className="scene-labels" ref={labels} aria-hidden="true" />
    </>
  );
}

function shortName(role: string): string {
  return role.charAt(0).toUpperCase() + role.slice(1);
}
