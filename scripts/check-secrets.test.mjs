import { describe, expect, it } from "vitest";
import { scan } from "./check-secrets.mjs";

// Test strings are assembled at run time so this file never holds a key-shaped line itself.
const fakeKey = ["sk", "ant", "api03", "A".repeat(90)].join("-");
const pemHeader = ["-----BEGIN", "PRIVATE KEY-----"].join(" ");

describe("check:secrets", () => {
  it("finds an Anthropic key and a private key in content, with the line, not the secret", () => {
    const found = scan("src/a.ts", `const ok = 1;\nconst k = "${fakeKey}";\n${pemHeader}\n`);
    expect(found).toEqual([
      { path: "src/a.ts", line: 2, what: "an Anthropic API key" },
      { path: "src/a.ts", line: 3, what: "a private key" },
    ]);
    expect(JSON.stringify(found)).not.toContain(fakeKey);
  });

  it("ignores short or templated look-alikes, as in the hosted-model tests", () => {
    expect(scan("t.ts", 'keyProblem("sk-ant-short")')).toEqual([]);
    expect(scan("t.ts", "const KEY = `sk-ant-api03-${'x'.repeat(80)}`;")).toEqual([]);
  });

  it("refuses tracked .env and key files by name; .env.example is fine", () => {
    for (const p of [
      ".env",
      "apps/engine/.env.local",
      "business-owner.json",
      "sourcing.key.json",
      "x/customer-owner.issuer.json",
      "keys/id.pem",
    ]) {
      expect(scan(p, "").length, p).toBe(1);
    }
    expect(scan(".env.example", "ANTHROPIC_API_KEY=")).toEqual([]);
    expect(scan("docs/ENV.md", "set .env first")).toEqual([]);
  });
});
