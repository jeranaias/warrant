// Bundles the hosted demo server (src/hosted.ts and the workspace packages it uses) into one
// plain-JS file, so Render starts it with `node` alone: no tsx, no TypeScript at runtime.
import { copyFileSync, mkdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";

const here = (p) => fileURLToPath(new URL(p, import.meta.url));

await build({
  entryPoints: [here("./src/hosted.ts")],
  outfile: here("./dist/hosted.mjs"),
  bundle: true,
  platform: "node",
  format: "esm",
  target: "node24",
  // Express and friends are CommonJS: give the bundle a real `require` for Node built-ins.
  banner: {
    js: "import { createRequire as __warrantRequire } from 'node:module'; const require = __warrantRequire(import.meta.url);",
  },
  logLevel: "warning",
});

// The agents' system prompts are read from disk next to the module (packages/agents/src/prompts.ts).
// In the bundle that module is dist/hosted.mjs, so the prompts go beside it (ADR-023: a visitor's
// own key runs the model agents on the hosted demo).
for (const role of ["sourcing", "support", "treasury"]) {
  mkdirSync(here(`./dist/${role}`), { recursive: true });
  copyFileSync(
    here(`../../packages/agents/src/${role}/prompt.md`),
    here(`./dist/${role}/prompt.md`),
  );
}
