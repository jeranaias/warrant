import { describe, expect, it } from "vitest";
import { agentsLabel, keyFacts, modelName, statusLine, usedUp } from "./model.js";
import type { ModelStatus } from "./model.js";

const scripted: ModelStatus = { mode: "scripted", callsUsed: 0, callsCap: 150 };
const haiku: ModelStatus = {
  mode: "model",
  model: "claude-haiku-4-5",
  callsUsed: 12,
  callsCap: 150,
};

describe("model status words (ADR-023)", () => {
  it("names the model by family", () => {
    expect(modelName("claude-haiku-4-5")).toBe("Haiku");
    expect(modelName("claude-sonnet-5")).toBe("Sonnet");
    expect(modelName(undefined)).toBe("model");
    expect(modelName("other-model")).toBe("other-model");
  });

  it("says what runs the agents, and when the calls are used up", () => {
    expect(agentsLabel(scripted)).toBe("Agents: scripted");
    expect(agentsLabel(haiku)).toBe("Agents: Haiku · your key");
    const spent = { ...haiku, callsUsed: 150 };
    expect(usedUp(spent)).toBe(true);
    expect(usedUp(scripted)).toBe(false);
    expect(agentsLabel(spent)).toBe("Agents: Haiku · calls used up");
    expect(statusLine(haiku)).toBe("Now: Haiku on your key · 12 of 150 calls used.");
    expect(statusLine(scripted)).toBe("Now: scripted agents, deterministic purpose check.");
  });

  it("states where the key lives and what it costs, with the session's cap", () => {
    const facts = keyFacts(150).join(" ");
    expect(facts).toContain("Never stored or logged");
    expect(facts).toContain("at most 150 per session");
    expect(facts).toContain("Money stays simulated");
  });
});
