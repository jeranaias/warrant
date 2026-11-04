import { useEffect, useState } from "react";
import { api } from "../api.js";
import type { ChainView, WarrantRow } from "../api.js";
import { SCENARIOS, cents, scenarioLabel } from "../format.js";

/**
 * Demo controls, not owner controls: change the world the agents live in. Raise the data
 * supplier's price, load a scenario (the queue of offers, tickets and invoices), or ask the
 * treasury agent to review spending: it decides what to propose (after a price rise, a sourcing
 * cap that fits), and that lands in "Waiting for you".
 */
/** The prices the demo can set the data supplier to, in cents. */
const PRICES = [2, 4];

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
  const cap = sourcing?.perPaymentCap;
  const overCap = cap ? PRICES.filter((c) => c > cap.cents) : [];

  return (
    <section className="panel">
      <h2>Scenarios</h2>
      <p className="muted small">For the demo. These change the world, not your rules.</p>
      <div className="row">
        <span>Data supplier's price: {cents(price)}</span>
        {PRICES.map((c) => (
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
            {price === undefined || price === c
              ? `${c} cents`
              : `${c > price ? "Raise" : "Lower"} to ${c} cents`}
          </button>
        ))}
      </div>
      {cap && overCap.length > 0 && (
        <p className="muted small">
          {overCap.map((c) => `${c} cents`).join(", ")} is over the sourcing agent's{" "}
          {cents(cap.cents, cap.currency)} cap.
        </p>
      )}
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
      {sourcing && treasury && (
        <div className="row">
          <button
            className="btn"
            onClick={() =>
              void run(async () => {
                await api.reviewSpending();
                return "Treasury is reviewing spending. Anything it proposes waits for you.";
              })
            }
          >
            Ask treasury to review spending
          </button>
        </div>
      )}
      {note && <p className="note small">{note}</p>}
    </section>
  );
}
