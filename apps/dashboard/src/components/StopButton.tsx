import { useEffect, useRef, useState } from "react";
import { api } from "../api.js";
import type { KillState } from "../api.js";
import { keyOf } from "./Approvals.js";

/**
 * The emergency stop: one click, then one confirm (apps/dashboard/CLAUDE.md: never more).
 * Shows how long the engine took to stop everything.
 */
export function StopButton({
  kill,
  onDone,
  onError,
  big = false,
  hotkeys = false,
  terse = false,
}: {
  kill: KillState | null;
  onDone: () => void;
  onError: (e: string) => void;
  big?: boolean;
  /** S arms, Enter confirms, Esc cancels. */
  hotkeys?: boolean;
  /** Once stopped, show one word: the page shows the receipt elsewhere. */
  terse?: boolean;
}) {
  const [arming, setArming] = useState(false);
  const [sending, setSending] = useState(false);
  const size = big ? "big" : "";

  const stop = async () => {
    setArming(false);
    setSending(true);
    try {
      await api.kill("owner pressed stop");
    } catch (e) {
      onError((e as Error).message);
    } finally {
      setSending(false);
      onDone();
    }
  };

  const keys = useRef({ arming, stop });
  keys.current = { arming, stop };
  useEffect(() => {
    if (!hotkeys) return;
    const on = (e: KeyboardEvent) => {
      const k = keyOf(e);
      if (k === "s") setArming(true);
      else if (k === "Enter" && keys.current.arming) void keys.current.stop();
      else if (k === "Escape") setArming(false);
    };
    window.addEventListener("keydown", on);
    return () => window.removeEventListener("keydown", on);
  }, [hotkeys]);

  if (kill?.engaged && terse) {
    return (
      <div className={`stopped ${size}`} role="status">
        <strong>Stopped</strong>
      </div>
    );
  }

  if (kill?.engaged) {
    return (
      <div className={`stopped ${size}`} role="status">
        <strong>Everything is stopped.</strong>
        {kill.last && (
          <span>
            {" "}
            Took {kill.last.durationMs} ms. {kill.last.revokedMandates.length} mandate(s) revoked.
            {kill.last.problems.length > 0 && ` Problems: ${kill.last.problems.join("; ")}`}
          </span>
        )}
      </div>
    );
  }

  return arming ? (
    <div className={`stop-confirm ${size}`}>
      <button className={`btn kill ${size}`} onClick={() => void stop()}>
        Yes, stop all money now{hotkeys && <kbd>Enter</kbd>}
      </button>
      <button className={`btn ${size}`} onClick={() => setArming(false)}>
        Cancel
      </button>
    </div>
  ) : (
    <button
      className={`btn kill ${size}`}
      disabled={sending}
      onClick={() => setArming(true)}
      title="Refuse every payment, drop what is waiting, revoke the mandates"
    >
      STOP{hotkeys && <kbd>S</kbd>}
    </button>
  );
}
