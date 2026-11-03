import { useEffect, useRef, useState } from "react";
import type { FormEvent } from "react";
import { createPortal } from "react-dom";
import { api } from "../api.js";
import { agentsLabel, keyFacts, statusLine } from "../model.js";
import type { ModelStatus } from "../model.js";

/**
 * Hosted demo only (ADR-023): run this visitor's agents on their own Anthropic key. Shows nothing
 * where the server has no such route (local `pnpm engine`). A key that is set or forgotten starts
 * the session over, like Reset.
 */
export function ModelKey() {
  const [status, setStatus] = useState<ModelStatus | null>(null);
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const input = useRef<HTMLInputElement>(null);

  useEffect(() => {
    api.model().then(setStatus, () => setStatus(null));
  }, []);

  useEffect(() => {
    if (!open) return;
    input.current?.focus();
    const on = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    window.addEventListener("keydown", on);
    return () => window.removeEventListener("keydown", on);
  }, [open]);

  if (!status) return null;

  const restart = () => location.assign("/");
  const fail = (e: Error) => {
    setBusy(false);
    setError(e.message);
  };
  const use = (e: FormEvent) => {
    e.preventDefault();
    const key = input.current?.value ?? "";
    setBusy(true);
    setError(null);
    api.useModelKey(key).then(() => {
      if (input.current) input.current.value = "";
      restart();
    }, fail);
  };
  const forget = () => {
    setBusy(true);
    setError(null);
    api.forgetModelKey().then(restart, fail);
  };

  return (
    <>
      <button className="btn link" onClick={() => setOpen(true)}>
        {agentsLabel(status)}
      </button>
      {" · "}
      {open &&
        createPortal(
          <div className="key-veil" onClick={() => setOpen(false)}>
            <form
              className="key-dialog"
              role="dialog"
              aria-modal="true"
              aria-labelledby="key-title"
              onClick={(e) => e.stopPropagation()}
              onSubmit={use}
            >
              <div className="key-head">
                <h2 id="key-title">Agents</h2>
                <button
                  type="button"
                  className="drawer-x"
                  onClick={() => setOpen(false)}
                  aria-label="Close"
                >
                  ×
                </button>
              </div>
              <p className="key-now">{statusLine(status)}</p>
              <ul className="key-facts">
                {keyFacts(status.callsCap).map((f) => (
                  <li key={f}>{f}</li>
                ))}
              </ul>
              <label htmlFor="model-key">Anthropic API key</label>
              <input
                id="model-key"
                ref={input}
                type="password"
                autoComplete="off"
                spellCheck={false}
                placeholder="sk-ant-…"
                disabled={busy}
              />
              {error && <p className="key-error">{error}</p>}
              <div className="key-actions">
                <button type="submit" className="btn primary" disabled={busy}>
                  Use key
                </button>
                {status.mode === "model" && (
                  <button type="button" className="btn" onClick={forget} disabled={busy}>
                    Forget key
                  </button>
                )}
              </div>
            </form>
          </div>,
          document.body,
        )}
    </>
  );
}
