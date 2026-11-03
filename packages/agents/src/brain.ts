import type { AgentTask } from "@warrant/contracts";
import type { AgentContext } from "./context.js";

/**
 * Called once per `propose_payment` call. Returns the text the model gets back as the tool result
 * (control's decision in a few words).
 */
export type Propose = (input: unknown) => Promise<string>;

/**
 * Called once per `propose_limits` call (treasury, spend reviews only; ADR-020). Same contract as
 * `Propose`: the input is untrusted and the answer is control's decision in a few words.
 */
export type ProposeLimits = (input: unknown) => Promise<string>;

/**
 * Whatever decides what an agent does with a task: a model (`ModelBrain`) or a script
 * (`ScriptedBrain`). It may call `propose` (and, for a spend review, `proposeLimits`) zero or more
 * times. It never sees a rail, a key or a label.
 */
export interface Brain {
  readonly name: string;
  act(
    task: AgentTask,
    ctx: AgentContext,
    propose: Propose,
    proposeLimits?: ProposeLimits,
  ): Promise<void>;
}
