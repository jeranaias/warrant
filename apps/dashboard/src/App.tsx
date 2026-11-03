import { useEffect, useState } from "react";
import { CommandPage } from "./components/CommandPage.js";
import { Desk } from "./components/Desk.js";
import { Phone } from "./components/Phone.js";
import { useEngine } from "./useEngine.js";

/**
 * "#/m" is the phone page and "#/desk" the desktop dashboard. Anything else picks by width: a
 * narrow screen gets the phone page. Each comes as the decision desk (the default) or as the
 * flow through the gate; the Flow / Desk toggle picks, remembered per browser.
 */
function useHash(): string {
  const [hash, setHash] = useState(location.hash);
  useEffect(() => {
    const on = () => setHash(location.hash);
    window.addEventListener("hashchange", on);
    return () => window.removeEventListener("hashchange", on);
  }, []);
  return hash;
}

const NARROW = "(max-width: 700px)";

function useNarrow(): boolean {
  const [narrow, setNarrow] = useState(
    () => typeof matchMedia !== "undefined" && matchMedia(NARROW).matches,
  );
  useEffect(() => {
    if (typeof matchMedia === "undefined") return;
    const q = matchMedia(NARROW);
    const on = () => setNarrow(q.matches);
    q.addEventListener("change", on);
    return () => q.removeEventListener("change", on);
  }, []);
  return narrow;
}

type View = "desk" | "flow";
const VIEW_KEY = "warrant.view";

function useView(): [View, (v: View) => void] {
  const [view, setView] = useState<View>(() => {
    try {
      return localStorage.getItem(VIEW_KEY) === "flow" ? "flow" : "desk";
    } catch {
      return "desk";
    }
  });
  const set = (v: View) => {
    setView(v);
    try {
      localStorage.setItem(VIEW_KEY, v);
    } catch {
      // per-viewer convenience only
    }
  };
  return [view, set];
}

export function App() {
  const engine = useEngine();
  const hash = useHash();
  const narrow = useNarrow();
  const [view, setView] = useView();
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

  const phone = hash.startsWith("#/m") || (narrow && !hash.startsWith("#/desk"));
  if (view === "desk") {
    return (
      <Desk
        engine={engine}
        banner={banner}
        narrow={phone}
        onError={setActionError}
        onFlow={() => setView("flow")}
      />
    );
  }
  if (phone) {
    return (
      <>
        {banner}
        <Phone
          engine={engine}
          onDone={engine.refresh}
          onError={setActionError}
          onDesk={() => setView("desk")}
        />
      </>
    );
  }

  return (
    <CommandPage
      engine={engine}
      banner={banner}
      onError={setActionError}
      onDesk={() => setView("desk")}
    />
  );
}
