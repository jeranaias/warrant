/**
 * One calm tint per agent, in agent order, shared by the streams in the gate and the dots in
 * the agent list. All cool and muted on purpose: red and amber are kept for state (blocked,
 * waiting, stopped) and never used as an agent's colour.
 */
export const AGENT_TINTS = ["#8fb8de", "#7cc6bb", "#b3a6e3", "#a9c48f", "#d6a6c8", "#9ab0c4"];

export const tintOf = (index: number): string =>
  AGENT_TINTS[index % AGENT_TINTS.length] ?? "#9ab0c4";
