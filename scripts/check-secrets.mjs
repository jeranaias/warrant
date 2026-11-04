#!/usr/bin/env node
/**
 * `pnpm check:secrets` (in `pnpm verify` and CI): fails if a file tracked by git holds a secret.
 *
 * - Content: an Anthropic API key, or a private key block.
 * - Names: a `.env` file (only `.env.example` may be tracked), Metal owner keys, mandate keys,
 *   issuer keys and `.pem` files. Those live in `.env` and METAL_HOME, outside git.
 *
 * Prints the file and line of each finding, never the secret itself.
 */
import { execFileSync } from "node:child_process";
import { readFileSync, statSync } from "node:fs";
import { fileURLToPath } from "node:url";

// Built from parts so this file never matches itself.
const ANTHROPIC = new RegExp(["sk", "ant", "[a-z0-9]+", "[A-Za-z0-9_-]{40,}"].join("-"));
const PRIVATE_KEY = new RegExp(["-----BEGIN", "[A-Z ]*PRIVATE KEY-----"].join(" "));

const CONTENT_RULES = [
  { what: "an Anthropic API key", re: ANTHROPIC },
  { what: "a private key", re: PRIVATE_KEY },
];

const NAME_RULES = [
  { what: "a .env file", re: /(^|\/)\.env(\..+)?$/, allow: /(^|\/)\.env\.example$/ },
  { what: "a Metal owner key", re: /-owner\.json$/ },
  { what: "a mandate key", re: /\.key\.json$/ },
  { what: "an issuer key", re: /\.issuer(\.public)?\.json$/ },
  { what: "a .pem key", re: /\.pem$/ },
];

/** Findings for one file: `{ path, line?, what }`. Never includes the matched text. */
export function scan(path, text) {
  const out = [];
  for (const r of NAME_RULES) {
    if (r.re.test(path) && !(r.allow && r.allow.test(path))) out.push({ path, what: r.what });
  }
  if (text !== undefined) {
    const lines = text.split(/\r?\n/);
    lines.forEach((l, i) => {
      for (const r of CONTENT_RULES)
        if (r.re.test(l)) out.push({ path, line: i + 1, what: r.what });
    });
  }
  return out;
}

/** Text of a tracked file, or undefined for big or binary files. */
function readText(path) {
  try {
    if (statSync(path).size > 2_000_000) return undefined;
    const buf = readFileSync(path);
    return buf.includes(0) ? undefined : buf.toString("utf8");
  } catch {
    return undefined;
  }
}

function main() {
  const files = execFileSync("git", ["ls-files", "-z"], { encoding: "utf8" })
    .split("\0")
    .filter(Boolean);
  const findings = files.flatMap((f) => scan(f, readText(f)));
  if (findings.length === 0) {
    console.log(`check:secrets: ${files.length} tracked files, no secrets found`);
    return;
  }
  for (const f of findings) {
    console.error(`check:secrets: ${f.path}${f.line ? `:${f.line}` : ""} looks like ${f.what}`);
  }
  console.error("Remove it from git (and rotate it if it was ever pushed).");
  process.exitCode = 1;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) main();
