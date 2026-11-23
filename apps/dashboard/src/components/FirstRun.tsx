import { useState } from "react";
import { api } from "../api.js";
import type { LoggedEvent } from "../api.js";

const KEY = "warrant.firstrun";
/** The scenario step 1 runs: every beat in one go. */
const FIRST_SCENARIO = "all";

function dismissedBefore(): boolean {
  try {
    return localStorage.getItem(KEY) === "off";
  } catch {
    return false;
  }
}

/**
 * Three steps for a first visit, along the bottom: run a scenario, decide what is held, press
 * STOP. A step that has happened shrinks to a tick, so only what is left reads as text. Gone
 * after STOP or when dismissed (remembered per browser).
 */
export function FirstRun({
  events,
  stopped,
  onDone,
  onError,
}: {
  events: LoggedEvent[];
  stopped: boolean;
  onDone: () => void;
  onError: (e: string) => void;
}) {
  const [hidden, setHidden] = useState(dismissedBefore);
  const [loading, setLoading] = useState(false);
  if (hidden || stopped) return null;

  const ran = events.some((e) => e.event.type === "proposal");
  const decided = events.some((e) => e.event.type === "approval_decided" && e.event.ok);

  const run = async () => {
    setLoading(true);
    try {
      await api.loadScenario(FIRST_SCENARIO);
    } catch (e) {
      onError((e as Error).message);
    } finally {
      setLoading(false);
      onDone();
    }
  };
  const dismiss = () => {
    setHidden(true);
    try {
      localStorage.setItem(KEY, "off");
    } catch {
      // per-viewer convenience only
    }
  };

  const tick = (label: string) => (
    <>
      <span className="fr-n" aria-hidden="true">
        ✓
      </span>
      <span className="sr-only">{label}: done</span>
    </>
  );

  return (
    <ol className="firstrun" aria-label="First steps">
      <li className={ran ? "done" : ""}>
        {ran ? (
          tick("Run a scenario")
        ) : (
          <>
            <span className="fr-n">1</span>
            <button className="btn link" disabled={loading} onClick={() => void run()}>
              Run a scenario
            </button>
          </>
        )}
      </li>
      <li className={decided ? "done" : ""}>
        {decided ? (
          tick("Decide what's held for you")
        ) : (
          <>
            <span className="fr-n">2</span>Decide what's held for you
          </>
        )}
      </li>
      <li>
        <span className="fr-n">3</span>Press STOP
      </li>
      <li className="fr-x">
        <button className="drawer-x" onClick={dismiss} aria-label="Hide these steps">
          ×
        </button>
      </li>
    </ol>
  );
}
