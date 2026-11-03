/**
 * Hosted demo: what this visitor's agents run on (GET /api/model, ADR-023), in plain words. Pure,
 * so model.test.ts can pin the wording. The key itself never reaches the page after it is sent.
 */

export interface ModelStatus {
  mode: "scripted" | "model";
  model?: string;
  callsUsed: number;
  callsCap: number;
}

/**
 * Model calls a full run of every scenario takes: 14 tasks at about two agent turns each, plus a
 * purpose check for each payment that passes the rules. An estimate, shown as one.
 */
export const CALLS_PER_RUN = 40;

/** "claude-haiku-4-5" → "Haiku". */
export function modelName(id: string | undefined): string {
  const m = /claude-([a-z]+)/.exec(id ?? "");
  if (!m?.[1]) return id ?? "model";
  return m[1].charAt(0).toUpperCase() + m[1].slice(1);
}

export const usedUp = (s: ModelStatus) => s.mode === "model" && s.callsUsed >= s.callsCap;

/** The header control: what runs the agents now. */
export function agentsLabel(s: ModelStatus): string {
  if (s.mode === "scripted") return "Agents: scripted";
  return `Agents: ${modelName(s.model)} · ${usedUp(s) ? "calls used up" : "your key"}`;
}

/** One line for the dialog. */
export function statusLine(s: ModelStatus): string {
  if (s.mode === "scripted") return "Now: scripted agents, deterministic purpose check.";
  return `Now: ${modelName(s.model)} on your key · ${s.callsUsed} of ${s.callsCap} calls used.`;
}

/** The facts a person needs before pasting a key. */
export function keyFacts(cap: number): string[] {
  return [
    "Your Anthropic key runs this session's agents and purpose check on Haiku. Money stays simulated.",
    "Held in this session's server memory only. Never stored or logged. Removed on Forget key, Reset, or when the session ends.",
    `Calls bill your Anthropic account: about ${CALLS_PER_RUN} for a full run, at most ${cap} per session.`,
    "Using or forgetting a key starts this session over.",
  ];
}
