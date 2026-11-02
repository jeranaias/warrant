import { useEffect, useState } from "react";
import { api } from "../api.js";
import type { ChainView, WarrantRow } from "../api.js";
import { SCENARIOS, cents, scenarioLabel } from "../format.js";

/**
 * Demo controls, not owner controls: change the world the agents live in. Raise the data
 * supplier's price, load a scenario (the queue of offers, tickets and invoices), or have treasury
 * ask for a sourcing cap that fits the new price (it lands in "Waiting for you").
 */
export function Scene({
  chain,
  warrants,
  onDone,
  onError,
}: {
  chain: ChainView | null;
  warrants: WarrantRow[];
  onDone: () => void;
  onError: (e: string) => void;
}) {
  const [scenarios, setScenarios] = useState<string[]>([]);
  const [picked, setPicked] = useState("all");
  const [note, setNote] = useState<string | null>(null);

  useEffect(() => {
    api
      .scenarios()
      .then((r) => setScenarios(r.scenarios))
      .catch(() => setScenarios([]));
  }, []);

  const run = async (what: () => Promise<string>) => {
    try {
      setNote(await what());
    } catch (e) {
      onError((e as Error).message);
    } finally {
      onDone();
    }
  };

  const price = chain?.upstreamPriceCents;
  const sourcing = warrants.find((w) => w.agentRole === "sourcing");
  const treasury = warrants.find((w) => w.agentRole === "treasury");

  return (
    <section className="panel">
      <h2>Scenarios</h2>
      <p className="muted small">For the demo. These change the world, not your rules.</p>
      <div className="row">
        <span>Data supplier's price: {cents(price)}</span>
        {[2, 4].map((c) => (
          <button
            key={c}
            className="btn"
            disabled={price === c}
            onClick={() =>
              void run(async () => {
                const r = await api.setUpstreamPrice(c);
                return `The data supplier now charges ${cents(r.upstreamPriceCents)} per call.`;
              })
            }
          >
            Set {c} cents
          </button>
        ))}
      </div>
      <div className="row">
        <label>
          Scenario{" "}
          <select value={picked} onChange={(e) => setPicked(e.target.value)}>
            {(scenarios.length ? scenarios : ["all"]).map((s) => (
              <option key={s} value={s}>
                {scenarioLabel(s)}
              </option>
            ))}
          </select>
        </label>
        <button
          className="btn"
          onClick={() =>
            void run(async () => {
              const r = await api.loadScenario(picked);
              return `${scenarioLabel(picked)}: ${r.queued} task(s) queued for the agents.`;
            })
          }
        >
          Run
        </button>
      </div>
      {SCENARIOS[picked] && <p className="muted small">{SCENARIOS[picked].what}</p>}
      {sourcing && treasury && price !== undefined && (
        <div className="row">
          <button
            className="btn"
            disabled={sourcing.perPaymentCap.cents === price}
            onClick={() =>
              void run(async () => {
                const r = await api.proposeBudgetChange({
                  proposalId: `bud_${Date.now()}`,
                  warrantId: sourcing.warrantId,
                  agentId: treasury.agentId,
                  newTotalBudget: sourcing.totalBudget,
                  newPerPaymentCap: { currency: sourcing.perPaymentCap.currency, cents: price },
                  justification: "Upstream raised its price; match the sourcing cap to it.",
                  createdAt: new Date().toISOString(),
                });
                if (!r.ok) throw new Error(r.error ?? "budget change refused");
                return "Treasury asked for a new sourcing cap. It is waiting for you.";
              })
            }
          >
            Treasury asks to set the sourcing cap to {cents(price)}
          </button>
        </div>
      )}
      {note && <p className="note small">{note}</p>}
    </section>
  );
}
