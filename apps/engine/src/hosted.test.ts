import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import type { Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { deterministicPurpose } from "@warrant/control";
import { AUTH_COOKIE, AUTH_TTL_MS, FailureLimiter, authValid, signAuth } from "./hosted-auth.js";
import { SESSION_COOKIE, hostedApp } from "./hosted-app.js";
import type { Hosted, HostedOptions } from "./hosted-app.js";
import { SessionStore } from "./hosted-sessions.js";
import { createEngine } from "./server.js";

const CODE = "correct horse battery";
const SECRET = "test-cookie-secret-0123456789";

const dist = mkdtempSync(join(tmpdir(), "warrant-hosted-"));
mkdirSync(join(dist, "assets"));
writeFileSync(join(dist, "index.html"), "<!doctype html><title>Warrant</title>");
writeFileSync(join(dist, "assets", "app.js"), "console.log(1)");

const makeEngine = (ownerToken: string) =>
  createEngine({ purpose: deterministicPurpose, ownerToken });

let running: { hosted: Hosted; server: Server } | undefined;
afterEach(async () => {
  if (!running) return;
  const { hosted, server } = running;
  running = undefined;
  hosted.close();
  await new Promise<void>((ok) => server.close(() => ok()));
});

async function start(over: Partial<HostedOptions> = {}) {
  const hosted = hostedApp({
    password: CODE,
    cookieSecret: SECRET,
    distDir: dist,
    makeEngine,
    sweepMs: 0,
    ...over,
  });
  const server = hosted.app.listen(0, "127.0.0.1");
  await new Promise<void>((ok) => server.once("listening", () => ok()));
  running = { hosted, server };
  const a = server.address();
  const base = `http://127.0.0.1:${typeof a === "object" && a ? a.port : 0}`;
  return { hosted, base };
}

/** A browser stand-in: keeps cookies, never follows redirects. */
function visitor(base: string) {
  const jar = new Map<string, string>();
  const send = async (path: string, init: RequestInit = {}) => {
    const headers = new Headers(init.headers);
    if (jar.size) headers.set("cookie", [...jar].map(([k, v]) => `${k}=${v}`).join("; "));
    const r = await fetch(base + path, { ...init, headers, redirect: "manual" });
    for (const c of r.headers.getSetCookie()) {
      const m = /^([^=]+)=([^;]*)/.exec(c);
      if (m?.[1]) jar.set(m[1], m[2] ?? "");
    }
    return r;
  };
  const login = (code: string) =>
    send("/login", {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ code }).toString(),
    });
  /** Signs in and opens the demo; answers the owner key from the redirect. */
  const enter = async () => {
    expect((await login(CODE)).status).toBe(303);
    const r = await send("/");
    expect(r.status).toBe(302);
    const owner = /#\/\?owner=([A-Za-z0-9_-]+)$/.exec(r.headers.get("location") ?? "")?.[1];
    expect(owner).toBeTruthy();
    return owner ?? "";
  };
  const api = async <T>(path: string, body?: unknown, owner?: string) => {
    const headers: Record<string, string> = {};
    if (body !== undefined) headers["content-type"] = "application/json";
    if (owner) headers["authorization"] = `Bearer ${owner}`;
    const r = await send("/api" + path, {
      method: body === undefined ? "GET" : "POST",
      headers,
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    return { status: r.status, body: (await r.json()) as T };
  };
  return { jar, send, login, enter, api };
}

describe("hosted demo: sign-in", () => {
  it("keeps health open and cheap, and everything else behind the code", async () => {
    const { base, hosted } = await start();
    const r = await fetch(base + "/api/health");
    expect(r.status).toBe(200);
    expect(await r.json()).toEqual({ ok: true });
    expect(hosted.sessions.size).toBe(0);

    const v = visitor(base);
    expect((await v.send("/")).headers.get("location")).toBe("/login");
    expect((await v.send("/demo")).headers.get("location")).toBe("/login");
    expect((await v.send("/assets/app.js")).headers.get("location")).toBe("/login");
    expect((await v.api("/world")).status).toBe(401);
    expect((await v.api("/reset", {})).status).toBe(401);
    expect((await v.send("/login")).status).toBe(200);
    expect(hosted.sessions.size).toBe(0);
  });

  it("refuses a wrong code and signs in with the right one", async () => {
    const { base } = await start();
    const v = visitor(base);
    expect((await v.login("wrong")).status).toBe(401);
    expect(v.jar.has(AUTH_COOKIE)).toBe(false);
    const ok = await v.login(CODE);
    expect(ok.status).toBe(303);
    const set = ok.headers.getSetCookie().join("\n");
    expect(set).toMatch(/HttpOnly/);
    expect(set).toMatch(/SameSite=Lax/);
    expect(set).not.toMatch(/Secure/); // plain http here
    expect((await v.send("/assets/app.js")).status).toBe(200);
  });

  it("marks the cookie Secure behind https", async () => {
    const { base } = await start();
    const r = await fetch(base + "/login", {
      method: "POST",
      headers: {
        "content-type": "application/x-www-form-urlencoded",
        "x-forwarded-proto": "https",
      },
      body: `code=${encodeURIComponent(CODE)}`,
      redirect: "manual",
    });
    expect(r.headers.getSetCookie().join("\n")).toMatch(/Secure/);
  });

  it("rejects a tampered or expired cookie", async () => {
    const now = Date.parse("2026-11-02T12:00:00Z");
    const good = signAuth(SECRET, now + 1000);
    expect(authValid(SECRET, good, now)).toBe(true);
    expect(authValid(SECRET, good, now + 1000)).toBe(false); // expired
    expect(authValid("another-secret-0123456789", good, now)).toBe(false);
    const [, sig] = good.split(".");
    expect(authValid(SECRET, `${now + AUTH_TTL_MS * 10}.${sig}`, now)).toBe(false); // longer life
    expect(authValid(SECRET, undefined, now)).toBe(false);
    expect(authValid(SECRET, "garbage", now)).toBe(false);

    const { base } = await start();
    const v = visitor(base);
    v.jar.set(AUTH_COOKIE, `${Date.now() + 60_000}.${"A".repeat(43)}`);
    expect((await v.api("/world")).status).toBe(401);
    v.jar.set(AUTH_COOKIE, signAuth(SECRET, Date.now() - 1));
    expect((await v.send("/")).headers.get("location")).toBe("/login");
    v.jar.set(AUTH_COOKIE, signAuth(SECRET, Date.now() + 60_000));
    expect((await v.send("/")).headers.get("location")).toMatch(/^\/demo#\/\?owner=/);
  });

  it("rate-limits failed attempts per address", async () => {
    const { base } = await start({ limiter: new FailureLimiter(3, 60_000) });
    const v = visitor(base);
    for (let i = 0; i < 3; i++) expect((await v.login("nope")).status).toBe(401);
    expect((await v.login("nope")).status).toBe(429);
    expect((await v.login(CODE)).status).toBe(429); // even the right code waits out the window
  });

  it("refuses to start without a code or a cookie secret", () => {
    const base = { distDir: dist, makeEngine };
    expect(() => hostedApp({ ...base, password: "", cookieSecret: SECRET })).toThrow(
      /DEMO_PASSWORD/,
    );
    expect(() => hostedApp({ ...base, password: CODE, cookieSecret: "" })).toThrow(
      /DEMO_COOKIE_SECRET/,
    );
  });
});

describe("hosted demo: one engine per visitor", () => {
  it("gives two visitors two engines; STOP in one leaves the other running", async () => {
    const { base, hosted } = await start();
    const a = visitor(base);
    const b = visitor(base);
    const ownerA = await a.enter();
    const ownerB = await b.enter();
    expect(ownerA).not.toBe(ownerB);
    expect(a.jar.get(SESSION_COOKIE)).not.toBe(b.jar.get(SESSION_COOKIE));
    expect(hosted.sessions.size).toBe(2);
    expect((await a.send("/demo")).status).toBe(200);

    // Each owner key works only in its own engine.
    expect((await a.api("/kill", { reason: "test" }, ownerB)).status).toBe(401);
    expect((await a.api("/kill", { reason: "test" }, ownerA)).status).toBe(200);
    expect((await a.api<{ engaged: boolean }>("/kill")).body.engaged).toBe(true);
    expect((await b.api<{ engaged: boolean }>("/kill")).body.engaged).toBe(false);

    // Work taken in one engine is still queued in the other.
    const take = await a.api<{ tasks: unknown[] }>("/tasks?role=sourcing&limit=100");
    expect(take.body.tasks.length).toBeGreaterThan(0);
    expect((await a.api<{ tasks: unknown[] }>("/tasks?role=sourcing")).body.tasks).toEqual([]);
    expect(
      (await b.api<{ tasks: unknown[] }>("/tasks?role=sourcing")).body.tasks.length,
    ).toBeGreaterThan(0);
  });

  it("reset gives the visitor a fresh engine and keeps their owner key", async () => {
    const { base } = await start();
    const a = visitor(base);
    const owner = await a.enter();
    await a.api("/kill", { reason: "test" }, owner);
    expect((await a.api<{ engaged: boolean }>("/kill")).body.engaged).toBe(true);
    expect((await a.api("/reset", {})).status).toBe(200);
    expect((await a.api<{ engaged: boolean }>("/kill")).body.engaged).toBe(false);
    expect((await a.send("/")).headers.get("location")).toBe(`/demo#/?owner=${owner}`);
  });

  it("sends a visitor whose session ended back through / for a new one", async () => {
    const { base } = await start({ max: 1 });
    const a = visitor(base);
    const b = visitor(base);
    await a.enter();
    await b.enter(); // evicts a
    expect((await a.api("/world")).status).toBe(401);
    expect((await a.send("/demo")).headers.get("location")).toBe("/");
  });
});

describe("SessionStore", () => {
  it("evicts the least recently used session when full", () => {
    const store = new SessionStore({ makeEngine, max: 2, sweepMs: 0 });
    const s1 = store.create();
    const s2 = store.create();
    store.get(s1.id); // s2 is now the oldest
    const s3 = store.create();
    expect(store.size).toBe(2);
    expect(store.get(s2.id)).toBeUndefined();
    expect(store.get(s1.id)).toBe(s1);
    expect(store.get(s3.id)).toBe(s3);
    store.close();
  });

  it("drops sessions idle longer than the limit", () => {
    let t = 0;
    const store = new SessionStore({ makeEngine, idleMs: 1000, sweepMs: 0, now: () => t });
    const s1 = store.create();
    const s2 = store.create();
    t = 900;
    store.get(s2.id);
    t = 1500;
    store.sweep();
    expect(store.size).toBe(1);
    expect(store.get(s1.id)).toBeUndefined();
    expect(store.get(s2.id)).toBe(s2);
    t = 5000;
    expect(store.get(s2.id)).toBeUndefined();
    store.close();
  });
});
