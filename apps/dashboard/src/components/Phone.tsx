import type { EngineState } from "../useEngine.js";
import { Approvals } from "./Approvals.js";
import { Activity } from "./Activity.js";
import { StopButton } from "./StopButton.js";

/**
 * The owner's phone (open the dashboard at #/m): only what needs a thumb. What is waiting, the
 * stop button, and the last few things that happened.
 */
export function Phone({
  engine,
  onDone,
  onError,
}: {
  engine: EngineState;
  onDone: () => void;
  onError: (e: string) => void;
}) {
  const stopped = engine.kill?.engaged ?? false;
  return (
    <div className="phone">
      <header className="phone-head">
        <h1>Warrant</h1>
        <span className={`badge ${stopped ? "stop" : engine.approvals.length ? "wait" : "ok"}`}>
          {stopped ? "everything stopped" : `${engine.approvals.length} waiting`}
        </span>
      </header>
      <Approvals approvals={engine.approvals} onDone={onDone} onError={onError} />
      <div className="phone-stop">
        <StopButton kill={engine.kill} onDone={onDone} onError={onError} big />
      </div>
      <Activity events={engine.events} limit={8} />
    </div>
  );
}
