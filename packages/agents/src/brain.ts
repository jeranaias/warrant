import type { AgentTask } from "@warrant/contracts";
import type { AgentContext } from "./context.js";

/**
 * Called once per `propose_payment` call. Returns the text the model gets back as the tool result
 * (control's decision in a few words).
 */
export type Propose = (input: unknown) => Promise<string>;

/**
 * Whatever decides what an agent does with a task: a model (`ModelBrain`) or a script
 * (`ScriptedBrain`). It may call `propose` zero or more times. It never sees a rail, a key, a
 * limit or a label.
 */
export interface Brain {
  readonly name: string;
  act(task: AgentTask, ctx: AgentContext, propose: Propose): Promise<void>;
}
