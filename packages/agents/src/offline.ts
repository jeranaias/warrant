/**
 * The agents without a model: the runner and the scripted brain only. Nothing here reads a file or
 * needs a key, so a bundle (the hosted demo, apps/engine/build-hosted.mjs) can carry it. The
 * model's prompts live in `./prompts.ts`, which reads them from disk; import the package root for
 * those.
 */
export { contextFor } from "./context.js";
export { counterIds } from "./tool.js";
export { ScriptedBrain } from "./scripted.js";
export { EngineClient, runTask } from "./runner.js";
