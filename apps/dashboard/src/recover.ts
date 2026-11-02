/**
 * Hosted demo only: a visitor's engine ends on a redeploy or after it sits idle, and the API then
 * answers 401. The sign-in cookie still holds, so going back to "/" starts a fresh session. This
 * does that at most once per RECOVER_GAP_MS, so a session that keeps failing shows its error
 * instead of reloading forever.
 */
export const RECOVER_KEY = "warrant.recovered";
export const RECOVER_GAP_MS = 30_000;

/** The parts of sessionStorage this needs; tests pass a plain object. */
export interface Store {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

/** True when it is going to "/" now; false when it recovered too recently or cannot remember. */
export function recoverSession(
  store: Store | undefined,
  now: number,
  go: () => void = () => location.assign("/"),
): boolean {
  if (!store) return false;
  try {
    const last = Number(store.getItem(RECOVER_KEY) ?? NaN);
    if (Number.isFinite(last) && now - last < RECOVER_GAP_MS) return false;
    store.setItem(RECOVER_KEY, String(now));
  } catch {
    return false;
  }
  go();
  return true;
}
