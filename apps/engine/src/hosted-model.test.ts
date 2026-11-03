import { mkdtempSync, writeFileSync } from "node:fs";
import type { Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { CreateMessage } from "@warrant/agents";
import { deterministicPurpose } from "@warrant/control";
import type { PurposeComplete } from "@warrant/control";
import { FailureLimiter } from "./hosted-auth.js";
import { hostedEngine, startAgents } from "./hosted-agents.js";
import { hostedApp } from "./hosted-app.js";
import type { Hosted, HostedOptions } from "./hosted-app.js";
import { MODEL_CALL_CAP, ModelCapReached, keyProblem, sessionModel } from "./hosted-model.js";
import type { ModelClients, SessionModel } from "./hosted-model.js";
import { createEngine } from "./server.js";
import type { Engine } from "./server.js";

/** Never a real key: the right shape only. */
const KEY = `sk-ant-api03-${"x".repeat(80)}`;
const CODE = "correct horse battery";
const SECRET = "test-cookie-secret-0123456789";
const dist = mkdtempSync(join(tmpdir(), "warrant-byok-"));
writeFileSync(join(dist, "index.html"), "<!doctype html><title>Warrant</title>");

/** A model that never proposes: one end_turn per task. Counts its calls. */
function fakeClients(over: Partial<ModelClients> = {}): ModelClients & { calls: number } {
  const c = {
    calls: 0,
    create: (async () => {
      c.calls++;
      return {
        id: "msg_1",
        type: "message",
        role: "assistant",
        model: "claude-haiku-4-5",
        content: [{ type: "text", text: "Nothing to pay." }],
        stop_reason: "end_turn",
        stop_sequence: null,
        usage: { input_tokens: 1, output_tokens: 1 },
      };
    }) as unknown as CreateMessage,
    complete: (async () => {
      c.calls++;
      return '{"verdict":"consistent","reasons":["matches_warrant_purpose"],"explanation":"fits"}';
    }) as PurposeComplete,
    verify: () => Promise.resolve(),
    ...over,
  };
  return c;
}

describe("keyProblem", () => {
  it("accepts the shape of an Anthropic key and nothing else", () => {
    expect(keyProblem(KEY)).toBeUndefined();
    expect(keyProblem(`  ${KEY}  `)).toBeUndefined();
    expect(keyProblem(undefined)).toBe("paste an Anthropic API key");
    expect(keyProblem("   ")).toBe("paste an Anthropic API key");
    expect(keyProblem(42)).toBe("paste an Anthropic API key");
    expect(keyProblem(`sk-proj-${"x".repeat(60)}`)).toBe(
      "an Anthropic API key starts with sk-ant-",
    );
    expect(keyProblem("sk-ant-short")).toBe("that doesn't look like an Anthropic API key");
    expect(keyProblem(`sk-ant-${"x".repeat(30)} ${"y".repeat(30)}`)).toBe(
      "that doesn't look like an Anthropic API key",
    );
  });
});

describe("sessionModel", () => {
  it("counts agent and purpose calls together and stops at the cap", async () => {
    const clients = fakeClients();
    const m = sessionModel(clients, 3);
    await m.create({} as never, "k");
    await m.complete({ model: "m", system: "s", user: "u" });
    await m.create({} as never, "k");
    expect(m.used()).toBe(3);
    expect(m.exhausted()).toBe(true);
    expect(() => m.create({} as never, "k")).toThrow(ModelCapReached);
    expect(() => m.complete({ model: "m", system: "s", user: "u" })).toThrow(ModelCapReached);
    expect(clients.calls).toBe(3);
  });
});

describe("hosted agents on the visitor's model", () => {
  const call = async (e: Engine, path: string, init: RequestInit = {}) => {
    const server = e.app.listen(0, "127.0.0.1");
    await new Promise<void>((ok) => server.once("listening", () => ok()));
    const a = server.address();
    try {
      const r = await fetch(`http://127.0.0.1:${typeof a === "object" && a ? a.port : 0}${path}`, {
        ...init,
        headers: { "content-type": "application/json" },
      });
      return (await r.json()) as Record<string, unknown>;
    } finally {
      server.closeAllConnections();
      server.close();
    }
  };
  const until = async (check: () => boolean | Promise<boolean>, ms = 10_000) => {
    const end = Date.now() + ms;
    while (Date.now() < end) {
      if (await check()) return;
      await new Promise((ok) => setTimeout(ok, 20));
    }
    throw new Error("timed out");
  };

  it("the agents call the model, through the session's counted clients", async () => {
    const clients = fakeClients();
    const m = sessionModel(clients);
    const e = hostedEngine("owner-key", m);
    const agents = startAgents(e, { paceMs: 1, idleMs: 5, model: m });
    try {
      await call(e, "/scenario", { method: "POST", body: JSON.stringify({ name: "normal" }) });
      await until(() => m.used() >= 3);
      expect(clients.calls).toBe(m.used());
    } finally {
      agents.stop();
    }
  });

  it("with its calls used up, the agents leave the queue alone", async () => {
    const m = sessionModel(fakeClients(), 0);
    const e = hostedEngine("owner-key", m);
    const agents = startAgents(e, { paceMs: 1, idleMs: 5, model: m });
    try {
      const { queued } = await call(e, "/scenario", {
        method: "POST",
        body: JSON.stringify({ name: "normal" }),
      });
      await new Promise((ok) => setTimeout(ok, 150));
      const { tasks } = (await call(e, "/tasks?role=sourcing&limit=100")) as { tasks: unknown[] };
      // Every sourcing task of the scenario is still there: none was taken.
      expect(tasks).toHaveLength(3);
      expect(queued).toBeGreaterThan(3);
    } finally {
      agents.stop();
    }
  });
});

describe("hosted demo: a visitor's own key (ADR-023)", () => {
  let running: { hosted: Hosted; server: Server } | undefined;
  afterEach(async () => {
    if (!running) return;
    const { hosted, server } = running;
    running = undefined;
    hosted.close();
    await new Promise<void>((ok) => server.close(() => ok()));
  });

  const engines: (SessionModel | undefined)[] = [];
  const agentRuns: (SessionModel | undefined)[] = [];

  async function start(over: Partial<HostedOptions> = {}) {
    engines.length = 0;
    agentRuns.length = 0;
    const hosted = hostedApp({
      password: CODE,
      cookieSecret: SECRET,
      distDir: dist,
      makeEngine: (ownerToken, model) => {
        engines.push(model);
        return createEngine({ purpose: deterministicPurpose, ownerToken, scenario: "none" });
      },
      startAgents: (_engine, model) => {
        agentRuns.push(model);
        return { stop: () => undefined };
      },
      sweepMs: 0,
      ...over,
    });
    const server = hosted.app.listen(0, "127.0.0.1");
    await new Promise<void>((ok) => server.once("listening", () => ok()));
    running = { hosted, server };
    const a = server.address();
    return { hosted, base: `http://127.0.0.1:${typeof a === "object" && a ? a.port : 0}` };
  }

  /** Signs in and opens the demo; every response body is kept so tests can search it. */
  async function visitor(base: string) {
    const jar = new Map<string, string>();
    const bodies: string[] = [];
    const send = async (path: string, init: RequestInit = {}) => {
      const headers = new Headers(init.headers);
      if (jar.size) headers.set("cookie", [...jar].map(([k, v]) => `${k}=${v}`).join("; "));
      const r = await fetch(base + path, { ...init, headers, redirect: "manual" });
      for (const c of r.headers.getSetCookie()) {
        const m = /^([^=]+)=([^;]*)/.exec(c);
        if (m?.[1]) jar.set(m[1], m[2] ?? "");
      }
      const text = await r.text();
      bodies.push(text, JSON.stringify([...r.headers]));
      return { status: r.status, text };
    };
    await send("/login", {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ code: CODE }).toString(),
    });
    await send("/");
    const json = async (method: string, path: string, body?: unknown, extra = {}) => {
      const r = await send("/api" + path, {
        method,
        headers: { "content-type": "application/json", ...extra },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
      return { status: r.status, body: JSON.parse(r.text || "{}") as Record<string, unknown> };
    };
    return { json, bodies };
  }

  it("runs the visitor's session on their key, and Forget key and Reset go back to scripted", async () => {
    const made: string[] = [];
    const { base } = await start({
      modelClients: (k) => {
        made.push(k);
        return fakeClients();
      },
    });
    const v = await visitor(base);
    expect((await v.json("GET", "/model")).body).toEqual({
      mode: "scripted",
      callsUsed: 0,
      callsCap: MODEL_CALL_CAP,
    });
    expect(engines).toEqual([undefined]);

    const on = await v.json("POST", "/model-key", { key: `  ${KEY}\n` });
    expect(on.status).toBe(200);
    expect(on.body).toEqual({
      mode: "model",
      model: "claude-haiku-4-5",
      callsUsed: 0,
      callsCap: MODEL_CALL_CAP,
    });
    expect(made).toEqual([KEY]);
    // A fresh engine and agents, both on the visitor's model.
    expect(engines).toHaveLength(2);
    expect(engines[1]).toBeDefined();
    expect(agentRuns[1]).toBe(engines[1]);
    expect((await v.json("GET", "/model")).body["mode"]).toBe("model");

    const off = await v.json("DELETE", "/model-key");
    expect(off.body["mode"]).toBe("scripted");
    expect(engines[2]).toBeUndefined();

    await v.json("POST", "/model-key", { key: KEY });
    expect((await v.json("POST", "/reset", {})).status).toBe(200);
    expect((await v.json("GET", "/model")).body["mode"]).toBe("scripted");
  });

  it("refuses a malformed key without calling Anthropic", async () => {
    const factory = vi.fn(() => fakeClients());
    const { base } = await start({ modelClients: factory });
    const v = await visitor(base);
    for (const key of [
      undefined,
      "",
      "sk-proj-abcdefghijklmnopqrstuvwxyz0123456789",
      "sk-ant-short",
    ]) {
      const r = await v.json("POST", "/model-key", key === undefined ? {} : { key });
      expect(r.status).toBe(400);
    }
    expect(factory).not.toHaveBeenCalled();
    expect((await v.json("GET", "/model")).body["mode"]).toBe("scripted");
  });

  /** Console output during `run`, for checking that a key never reaches the logs. */
  async function captureLogs(run: () => Promise<void>): Promise<string[]> {
    const logs: string[] = [];
    const spies = (["log", "error", "warn", "info"] as const).map((m) =>
      vi.spyOn(console, m).mockImplementation((...a: unknown[]) => void logs.push(a.join(" "))),
    );
    try {
      await run();
    } finally {
      for (const s of spies) s.mockRestore();
    }
    return logs;
  }

  it("a key Anthropic refuses is reported plainly, never echoed or logged", async () => {
    let bodies: string[] = [];
    const logs = await captureLogs(async () => {
      const { base } = await start({
        modelClients: () =>
          fakeClients({ verify: () => Promise.reject(new Error(`401 invalid x-api-key ${KEY}`)) }),
      });
      const v = await visitor(base);
      const r = await v.json("POST", "/model-key", { key: KEY });
      expect(r.status).toBe(400);
      expect(r.body).toEqual({ error: "Anthropic did not accept this key" });
      expect((await v.json("GET", "/model")).body["mode"]).toBe("scripted");
      bodies = v.bodies;
    });
    for (const text of [...bodies, ...logs]) expect(text).not.toContain("sk-ant-");
  });

  it("an accepted key appears in no response and no log", async () => {
    let bodies: string[] = [];
    const logs = await captureLogs(async () => {
      const { base } = await start({ modelClients: () => fakeClients() });
      const v = await visitor(base);
      expect((await v.json("POST", "/model-key", { key: KEY })).status).toBe(200);
      await v.json("GET", "/model");
      await v.json("GET", "/world");
      await v.json("GET", "/events");
      await v.json("GET", "/approvals");
      await v.json("DELETE", "/model-key");
      bodies = v.bodies;
    });
    for (const text of [...bodies, ...logs]) expect(text).not.toContain("sk-ant-");
  });

  it("limits key attempts per address", async () => {
    const { base } = await start({
      keyLimiter: new FailureLimiter(2),
      modelClients: () => fakeClients({ verify: () => Promise.reject(new Error("no")) }),
    });
    const v = await visitor(base);
    expect((await v.json("POST", "/model-key", { key: KEY })).status).toBe(400);
    expect((await v.json("POST", "/model-key", { key: "nope" })).status).toBe(400);
    expect((await v.json("POST", "/model-key", { key: KEY })).status).toBe(429);
  });

  it("refuses a key change from another site", async () => {
    const { base } = await start({ modelClients: () => fakeClients() });
    const v = await visitor(base);
    const cross = { "sec-fetch-site": "cross-site" };
    expect((await v.json("POST", "/model-key", { key: KEY }, cross)).status).toBe(403);
    expect((await v.json("DELETE", "/model-key", undefined, cross)).status).toBe(403);
    expect((await v.json("GET", "/model")).body["mode"]).toBe("scripted");
  });
});
