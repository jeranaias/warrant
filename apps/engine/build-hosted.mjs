// Bundles the hosted demo server (src/hosted.ts and the workspace packages it uses) into one
// plain-JS file, so Render starts it with `node` alone: no tsx, no TypeScript at runtime.
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
