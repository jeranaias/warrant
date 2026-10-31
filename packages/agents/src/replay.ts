import { readFileSync, writeFileSync } from "node:fs";
import type Anthropic from "@anthropic-ai/sdk";
import type { CreateMessage } from "./model.js";

/**
 * Record / replay of model responses (ADR-008). Tests and CI never call the API: they replay
 * responses recorded once with a real key. A fixture file is `{ "<role>/<taskId>/<turn>": Message }`.
 *
 * Record:  AGENT_RECORD=path/to/fixtures.json with ANTHROPIC_API_KEY set.
 * Replay:  replayCreate(loadFixtures(path)).
 * Fixtures hold model output only: no keys, no headers.
 */
export type Fixtures = Record<string, Anthropic.Message>;

export function loadFixtures(path: string | URL): Fixtures {
  return JSON.parse(readFileSync(path, "utf8")) as Fixtures;
}

/** Answers from fixtures; a missing key is an error, never a silent live call. */
export function replayCreate(fixtures: Fixtures): CreateMessage {
  return (_params, key) => {
    const hit = fixtures[key];
    if (!hit) return Promise.reject(new Error(`no recorded response for ${key}`));
    return Promise.resolve(hit);
  };
}

/** Wraps a real call and keeps every response under its key. Call `save()` when done. */
export function recordCreate(
  inner: CreateMessage,
  path: string,
): { create: CreateMessage; save: () => void } {
  const store: Fixtures = {};
  return {
    create: async (params, key) => {
      const res = await inner(params, key);
      store[key] = res;
      return res;
    },
    save: () => writeFileSync(path, JSON.stringify(store, null, 2) + "\n"),
  };
}
