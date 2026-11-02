import { useCallback, useEffect, useRef, useState } from "react";
import { HOSTED, api } from "./api.js";
import type { ChainView, KillState, LoggedEvent, PendingApproval, World } from "./api.js";

/** How often the dashboard asks the engine for news. Lower is livelier, higher is quieter. */
export const POLL_MS = 1_000;
/** How many events the feed keeps in memory. */
const MAX_EVENTS = 500;

export interface EngineState {
  world: World | null;
  approvals: PendingApproval[];
  kill: KillState | null;
  chain: ChainView | null;
  events: LoggedEvent[];
  connected: boolean;
  error: string | null;
}

/**
 * Polls the engine. Events are fetched incrementally with ?since=<last seq>; everything else is
 * re-read each tick. `refresh()` polls right away (call it after any button press).
 */
export function useEngine(): EngineState & { refresh: () => void } {
  const [state, setState] = useState<EngineState>({
    world: null,
    approvals: [],
    kill: null,
    chain: null,
    events: [],
    connected: false,
    error: null,
  });
  const since = useRef(0);
  const busy = useRef(false);

  const poll = useCallback(async () => {
    if (busy.current) return;
    busy.current = true;
    try {
      const [world, approvals, kill, chain, events] = await Promise.all([
        api.world(),
        api.approvals(),
        api.killState(),
        api.chain(),
        api.events(since.current),
      ]);
      const fresh = events.events;
      const last = fresh.at(-1);
      if (last) since.current = last.seq;
      setState((s) => ({
        world,
        approvals: approvals.pending,
        kill,
        chain,
        events: fresh.length ? [...s.events, ...fresh].slice(-MAX_EVENTS) : s.events,
        connected: true,
        error: null,
      }));
    } catch (e) {
      // The engine went away. When it comes back it starts a fresh log, so start over too.
      since.current = 0;
      setState((s) => ({
        ...s,
        events: [],
        connected: false,
        error: HOSTED
          ? `Cannot reach the engine (${(e as Error).message}).`
          : `Cannot reach the engine (${(e as Error).message}). Is \`pnpm engine\` running?`,
      }));
    } finally {
      busy.current = false;
    }
  }, []);

  useEffect(() => {
    void poll();
    const every = setInterval(() => void poll(), POLL_MS);
    return () => clearInterval(every);
  }, [poll]);

  return { ...state, refresh: () => void poll() };
}
