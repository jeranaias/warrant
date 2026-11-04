import { positiveInt } from "./env.js";
import Anthropic from "@anthropic-ai/sdk";
import { DEFAULT_AGENT_MODEL, ModelBrain, anthropicCreate, limitCalls } from "./model.js";
import type { CreateMessage } from "./model.js";
import type { Brain } from "./brain.js";
import { recordCreate } from "./replay.js";
import { ScriptedBrain } from "./scripted.js";

/** Model calls one run may make unless AGENT_MAX_CALLS says otherwise (a scenario takes ~10). */
export const DEFAULT_AGENT_MAX_CALLS = 100;

export interface BrainChoice {
  brain: Brain;
  /** Save recorded responses (AGENT_RECORD); call once at the end of the run. */
  done: () => void;
  /** Model calls so far and the cap; `undefined` for the scripted brain. */
  usage: () => { calls: number; max: number } | undefined;
}

/**
 * Pick the agent brain from the environment:
 * - no ANTHROPIC_API_KEY (CI, no credits): the naive scripted agent;
 * - ANTHROPIC_API_KEY set: the model (AGENT_MODEL, default Haiku), capped at AGENT_MAX_CALLS
 *   calls for the run (default `opts.maxCalls`, else 100); with AGENT_RECORD=<file> every
 *   response is also recorded there for replay in tests.
 * `AGENT_BRAIN=scripted` forces the script even when a key is set.
 */
export function brainFromEnv(
  env: NodeJS.ProcessEnv = process.env,
  opts: { maxCalls?: number } = {},
): BrainChoice {
  if (!env["ANTHROPIC_API_KEY"] || env["AGENT_BRAIN"] === "scripted") {
    return { brain: new ScriptedBrain(), done: () => undefined, usage: () => undefined };
  }
  const model = env["AGENT_MODEL"] ?? DEFAULT_AGENT_MODEL;
  const max = positiveInt(env, "AGENT_MAX_CALLS", opts.maxCalls ?? DEFAULT_AGENT_MAX_CALLS);
  const record = env["AGENT_RECORD"];
  // The key from `env`, not whatever process.env holds; the SDK keeps it and we never log it.
  let inner: CreateMessage = anthropicCreate(new Anthropic({ apiKey: env["ANTHROPIC_API_KEY"] }));
  let done: () => void = () => undefined;
  if (record) {
    const rec = recordCreate(inner, record);
    inner = rec.create;
    done = rec.save;
  }
  const capped = limitCalls(inner, max);
  return { brain: new ModelBrain({ create: capped.create, model }), done, usage: capped.usage };
}
