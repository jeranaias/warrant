import { DEFAULT_AGENT_MODEL, anthropicClient, anthropicCreate } from "@warrant/agents";
import type { CreateMessage } from "@warrant/agents";
import { anthropicComplete } from "@warrant/control";
import type { PurposeComplete } from "@warrant/control";

/**
 * Hosted demo: a visitor's own Anthropic key (ADR-023). With one, that visitor's agents and purpose
 * check run on the model instead of the scripted brain; money stays simulated (mock rails).
 *
 * The key lives only inside the SDK client these closures hold, for that one session: it is never
 * a field we store, log or send back. Forget key, Reset and the end of the session drop the
 * closures. Every model call counts against a per-session cap, so a key can't be run up by
 * leaving a tab open.
 */

/** Model calls one session may make, agents and purpose check together. */
export const MODEL_CALL_CAP = 150;

/** What a key opens: the agents' Messages call, the purpose check's, and a free key check. */
export interface ModelClients {
  create: CreateMessage;
  complete: PurposeComplete;
  /** Throws when Anthropic refuses the key. Must not bill (token counting is free). */
  verify: () => Promise<void>;
}

export type ModelClientFactory = (apiKey: string) => ModelClients;

export const anthropicClients: ModelClientFactory = (apiKey) => {
  const client = anthropicClient(apiKey);
  return {
    create: anthropicCreate(client),
    complete: anthropicComplete(client),
    verify: async () => {
      await client.messages.countTokens({
        model: DEFAULT_AGENT_MODEL,
        messages: [{ role: "user", content: "ok" }],
      });
    },
  };
};

/** Why a pasted key can't be an Anthropic API key, or undefined when it might be one. */
export function keyProblem(key: unknown): string | undefined {
  if (typeof key !== "string" || key.trim() === "") return "paste an Anthropic API key";
  const k = key.trim();
  if (!k.startsWith("sk-ant-")) return "an Anthropic API key starts with sk-ant-";
  if (k.length < 40 || k.length > 250 || !/^[A-Za-z0-9_-]+$/.test(k)) {
    return "that doesn't look like an Anthropic API key";
  }
  return undefined;
}

export class ModelCapReached extends Error {
  constructor() {
    super("this session's model calls are used up");
  }
}

/** One session's model access: the counted clients and how much of the cap is used. */
export interface SessionModel {
  readonly model: string;
  readonly cap: number;
  used: () => number;
  exhausted: () => boolean;
  create: CreateMessage;
  complete: PurposeComplete;
}

export function sessionModel(clients: ModelClients, cap = MODEL_CALL_CAP): SessionModel {
  let used = 0;
  const take = () => {
    if (used >= cap) throw new ModelCapReached();
    used++;
  };
  return {
    model: DEFAULT_AGENT_MODEL,
    cap,
    used: () => used,
    exhausted: () => used >= cap,
    create: (params, key) => {
      take();
      return clients.create(params, key);
    },
    complete: (req) => {
      take();
      return clients.complete(req);
    },
  };
}

/** GET /api/model: what this session's agents run on. Never carries the key. */
export interface ModelStatus {
  mode: "scripted" | "model";
  model?: string;
  callsUsed: number;
  callsCap: number;
}

export function modelStatus(m: SessionModel | undefined): ModelStatus {
  if (!m) return { mode: "scripted", callsUsed: 0, callsCap: MODEL_CALL_CAP };
  return { mode: "model", model: m.model, callsUsed: m.used(), callsCap: m.cap };
}
