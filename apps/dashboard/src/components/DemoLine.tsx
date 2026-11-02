import { api } from "../api.js";

/** Hosted demo only: what this is, and a way to start over with a fresh engine. */
export function DemoLine({ onError }: { onError: (e: string) => void }) {
  const reset = () => {
    api.reset().then(
      () => location.assign("/"),
      (e: Error) => onError(e.message),
    );
  };
  return (
    <span className="hud-demo">
      Demo · simulated money ·{" "}
      <button className="btn link" onClick={reset}>
        Reset
      </button>
    </span>
  );
}
