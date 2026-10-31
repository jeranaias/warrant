/**
 * The three agents (sourcing, support, treasury). Each is a system prompt (`<role>/prompt.md`)
 * plus the one money tool `propose_payment` (ADR-008). A `Brain` decides what to propose: the
 * model (`ModelBrain`, plain Anthropic SDK tool use) or the naive script (`ScriptedBrain`, for CI
 * and runs without a key). The runner fills ids and submits to control; agents never see a rail.
 */
export type { Brain, Propose } from "./brain.js";
export { contextFor } from "./context.js";
export type { AgentContext, WorldView } from "./context.js";
export { TOOL_NAME, counterIds, proposePaymentTool, toProposal } from "./tool.js";
export type { IdSource, ProposePaymentInput, ToProposalResult } from "./tool.js";
export { SYSTEM_PROMPTS, renderTask } from "./prompts.js";
export { DEFAULT_AGENT_MODEL, ModelBrain, anthropicCreate } from "./model.js";
export type { CreateMessage, ModelBrainOptions } from "./model.js";
export { loadFixtures, recordCreate, replayCreate } from "./replay.js";
export type { Fixtures } from "./replay.js";
export { ScriptedBrain, readInstructions } from "./scripted.js";
export type { Instructions } from "./scripted.js";
export { brainFromEnv } from "./brains.js";
export { EngineClient, outcomeOf, runLoop, runTask } from "./runner.js";
export type {
  EngineSubmitResult,
  LoopOptions,
  ProposalOutcome,
  ProposalRecord,
  RunTaskOptions,
  Submit,
  TaskRun,
} from "./runner.js";
