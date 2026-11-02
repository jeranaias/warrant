import { useEffect, useRef } from "react";
import type { Pass } from "../flow.js";

/** How many recent payments replay when the page opens. */
const REPLAY = 6;
/** At most this many new payments animate at once; the rest only count. */
const BURST = 12;

/**
 * Calls `onNew` with the payments that arrived since the last call (the last few on first
 * load), once `ready`. The gate (Gate.tsx) animates from this.
 */
export function usePassStream(passes: Pass[], ready: boolean, onNew: (fresh: Pass[]) => void) {
  const lastSeq = useRef<number | null>(null);
  const cb = useRef(onNew);
  cb.current = onNew;
  useEffect(() => {
    if (!ready) return;
    const since = lastSeq.current;
    const fresh = since === null ? passes.slice(-REPLAY) : passes.filter((p) => p.seq > since);
    lastSeq.current = passes[passes.length - 1]?.seq ?? since ?? 0;
    if (fresh.length) cb.current(fresh.slice(-BURST));
  }, [passes, ready]);
}
