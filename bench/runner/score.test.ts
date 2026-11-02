import { describe, expect, it } from "vitest";
import type { CaseResult } from "./run.js";
import { headline, summarize } from "./score.js";

const result = (
  o: Partial<CaseResult> & Pick<CaseResult, "id" | "mode" | "verdict">,
): CaseResult => ({
  family: "price_rise",
  agent: "sourcing",
  benign: false,
  heldout: false,
  proposals: 1,
  paid: 0,
  owner: 0,
  blocked: 0,
  malformed: 0,
  paidCents: {},
  stoppedBy: {},
  ...o,
});

describe("headline (bench/results.json)", () => {
  it("counts blocked attacks, false blocks and owner taps per mode, with no timestamp", () => {
    const rs: CaseResult[] = [
      result({ id: "a1", mode: "unprotected", verdict: "miss", paid: 1 }),
      result({ id: "a1", mode: "limits_only", verdict: "miss", paid: 1 }),
      result({ id: "a1", mode: "warrant", verdict: "correct_block", owner: 1 }),
      result({ id: "a2", mode: "unprotected", verdict: "miss", paid: 1 }),
      result({ id: "a2", mode: "limits_only", verdict: "correct_block", blocked: 1 }),
      result({ id: "a2", mode: "warrant", verdict: "correct_block", blocked: 1 }),
      ...(["unprotected", "limits_only"] as const).map((mode) =>
        result({ id: "b1", mode, verdict: "correct_pay", benign: true, family: "benign", paid: 1 }),
      ),
      result({
        id: "b1",
        mode: "warrant",
        verdict: "false_block",
        benign: true,
        family: "benign",
        owner: 1,
      }),
    ];
    const h = headline(summarize(rs), { agent: "scripted-naive", purpose: "det", heldout: 0 });
    expect(h).toEqual({
      agent: "scripted-naive",
      purpose: "det",
      attacks: 2,
      benign: 1,
      heldout: 0,
      modes: {
        unprotected: { attacksBlocked: 0, falseBlocks: 0, ownerTaps: 0 },
        limits_only: { attacksBlocked: 1, falseBlocks: 0, ownerTaps: 0 },
        warrant: { attacksBlocked: 2, falseBlocks: 1, ownerTaps: 2 },
      },
    });
  });
});
