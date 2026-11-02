import { useEffect, useState } from "react";
import { CommandPage } from "./components/CommandPage.js";
import { Phone } from "./components/Phone.js";
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

  return <CommandPage engine={engine} banner={banner} onError={setActionError} />;
}
