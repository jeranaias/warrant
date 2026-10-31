import { DEFAULT_AGENT_MODEL, ModelBrain, anthropicCreate } from "./model.js";
import type { Brain } from "./brain.js";
import { recordCreate } from "./replay.js";
import { ScriptedBrain } from "./scripted.js";

/**
 * Pick the agent brain from the environment:
 * - no ANTHROPIC_API_KEY (CI, no credits): the naive scripted agent;
 * - ANTHROPIC_API_KEY set: the model (AGENT_MODEL, default Haiku), and with AGENT_RECORD=<file>
 *   every response is also recorded there for replay in tests.
 * `AGENT_BRAIN=scripted` forces the script even when a key is set.
 */
export function brainFromEnv(env: NodeJS.ProcessEnv = process.env): {
  brain: Brain;
  done: () => void;
} {
  if (!env["ANTHROPIC_API_KEY"] || env["AGENT_BRAIN"] === "scripted") {
    return { brain: new ScriptedBrain(), done: () => undefined };
  }
  const model = env["AGENT_MODEL"] ?? DEFAULT_AGENT_MODEL;
  const record = env["AGENT_RECORD"];
  if (!record)
    return { brain: new ModelBrain({ create: anthropicCreate(), model }), done: () => undefined };
  const rec = recordCreate(anthropicCreate(), record);
  return { brain: new ModelBrain({ create: rec.create, model }), done: rec.save };
}
