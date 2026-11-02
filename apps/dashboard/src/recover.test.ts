import { describe, expect, it } from "vitest";
import { RECOVER_GAP_MS, RECOVER_KEY, recoverSession } from "./recover.js";
import type { Store } from "./recover.js";

const memory = (): Store & { data: Map<string, string> } => {
  const data = new Map<string, string>();
  return {
    data,
    getItem: (k) => data.get(k) ?? null,
    setItem: (k, v) => void data.set(k, v),
  };
};

describe("recoverSession", () => {
  it("starts a fresh session once, then waits out the gap before trying again", () => {
    const store = memory();
    let went = 0;
    const go = () => void (went += 1);
    expect(recoverSession(store, 1_000, go)).toBe(true);
    expect(store.data.get(RECOVER_KEY)).toBe("1000");
    expect(recoverSession(store, 1_000 + RECOVER_GAP_MS - 1, go)).toBe(false);
    expect(recoverSession(store, 1_000 + RECOVER_GAP_MS, go)).toBe(true);
    expect(went).toBe(2);
  });

  it("does nothing when it cannot remember (no storage, or storage throws)", () => {
    let went = 0;
    const go = () => void (went += 1);
    expect(recoverSession(undefined, 1, go)).toBe(false);
    const broken: Store = {
      getItem: () => {
        throw new Error("blocked");
      },
      setItem: () => undefined,
    };
    expect(recoverSession(broken, 1, go)).toBe(false);
    expect(went).toBe(0);
  });
});
