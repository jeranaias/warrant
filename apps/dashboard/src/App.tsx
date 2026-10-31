import { useEffect, useState } from "react";
import { Activity } from "./components/Activity.js";
import { Approvals } from "./components/Approvals.js";
import { Balances } from "./components/Balances.js";
import { Chain } from "./components/Chain.js";
import { Phone } from "./components/Phone.js";
import { Scene } from "./components/Scene.js";
import { StopButton } from "./components/StopButton.js";
import { useEngine } from "./useEngine.js";

/** "#/m" is the phone page; anything else is the desktop dashboard. */
function useHash(): string {
  const [hash, setHash] = useState(location.hash);
  useEffect(() => {
    const on = () => setHash(location.hash);
    window.addEventListener("hashchange", on);
    return () => window.removeEventListener("hashchange", on);
  }, []);
  return hash;
}

export function App() {
  const engine = useEngine();
  const hash = useHash();
  const [actionError, setActionError] = useState<string | null>(null);
  const error = actionError ?? engine.error;
  const stopped = engine.kill?.engaged ?? false;

  const banner = error && (
    <div className="error" role="alert">
      {error}
      {actionError && (
        <button className="btn link" onClick={() => setActionError(null)}>
          dismiss
        </button>
      )}
    </div>
  );

  if (hash.startsWith("#/m")) {
    return (
      <>
        {banner}
        <Phone engine={engine} onDone={engine.refresh} onError={setActionError} />
      </>
    );
  }

  return (
    <div className="app">
      <header className="top">
        <div>
          <h1>Warrant</h1>
          <span className="muted small">
            owner dashboard · {engine.connected ? "live" : "connecting"} ·{" "}
            <a href="#/m">phone view</a>
          </span>
        </div>
        <StopButton kill={engine.kill} onDone={engine.refresh} onError={setActionError} />
      </header>
      {banner}
      <main className="layout">
        <div className="col-main">
          <Approvals
            approvals={engine.approvals}
            onDone={engine.refresh}
            onError={setActionError}
          />
          {engine.world && <Balances warrants={engine.world.warrants} stopped={stopped} />}
          {engine.chain && <Chain chain={engine.chain} />}
          <Scene
            chain={engine.chain}
            warrants={engine.world?.warrants ?? []}
            onDone={engine.refresh}
            onError={setActionError}
          />
        </div>
        <aside className="col-side">
          <Activity events={engine.events} />
        </aside>
      </main>
    </div>
  );
}
