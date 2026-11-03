import { api } from "../api.js";
import { ModelKey } from "./ModelKey.js";

/**
 * Hosted demo only: what this is, what runs the agents (a visitor may use their own key, ADR-023),
 * and a way to start over with a fresh engine.
 */
export function DemoLine({ onError }: { onError: (e: string) => void }) {
  const reset = () => {
    api.reset().then(
      () => location.assign("/"),
      (e: Error) => onError(e.message),
    );
  };
  return (
    <span className="hud-demo">
      Demo · simulated money · <ModelKey />
      <button className="btn link" onClick={reset}>
        Reset
      </button>
    </span>
  );
}
