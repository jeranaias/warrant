import { existsSync } from "node:fs";
import { join } from "node:path";
import express from "express";
import type { Express, NextFunction, Request, Response } from "express";
import {
  AUTH_COOKIE,
  AUTH_TTL_MS,
  FailureLimiter,
  authValid,
  codeMatches,
  cookie,
  loginPage,
  parseCookies,
  signAuth,
} from "./hosted-auth.js";
import { SessionStore } from "./hosted-sessions.js";
import type { Session, SessionOptions } from "./hosted-sessions.js";

/**
 * The hosted demo (issue #89): the built dashboard and a per-visitor engine API behind one shared
 * access code. Mock rails only.
 *
 *   GET  /api/health   open, cheap, says nothing
 *   GET  /login        sign-in page; POST /login checks the code and sets the auth cookie
 *   GET  /             (signed in) makes this visitor's engine, then sends them to the owner link
 *   GET  /demo         the dashboard
 *   POST /api/reset    a fresh engine for this visitor
 *   ANY  /api/...      this visitor's engine (the same routes as `pnpm engine`)
 */

export const SESSION_COOKIE = "warrant_demo_session";

export interface HostedOptions extends SessionOptions {
  password: string;
  cookieSecret: string;
  /** The built dashboard (apps/dashboard/dist). */
  distDir: string;
  limiter?: FailureLimiter;
}

export interface Hosted {
  app: Express;
  sessions: SessionStore;
  close: () => void;
}

export function hostedApp(opts: HostedOptions): Hosted {
  if (!opts.password) throw new Error("DEMO_PASSWORD is required for the hosted demo");
  if (!opts.cookieSecret) throw new Error("DEMO_COOKIE_SECRET is required for the hosted demo");
  const now = opts.now ?? Date.now;
  const sessions = new SessionStore(opts);
  const limiter = opts.limiter ?? new FailureLimiter();
  const index = join(opts.distDir, "index.html");

  const app = express();
  app.disable("x-powered-by");
  // Render terminates TLS in front of us: trust its X-Forwarded-* headers for the client address.
  app.set("trust proxy", true);

  app.get("/api/health", (_req, res) => {
    res.json({ ok: true });
  });

  app.get("/login", (_req, res) => {
    res.type("html").send(loginPage());
  });

  app.post("/login", express.urlencoded({ extended: false, limit: "2kb" }), (req, res) => {
    const ip = req.ip ?? "unknown";
    if (limiter.blocked(ip, now())) {
      res.status(429).type("html").send(loginPage("Too many attempts. Try again in 10 minutes."));
      return;
    }
    const code = (req.body as { code?: unknown } | undefined)?.code;
    if (typeof code !== "string" || !codeMatches(code, opts.password)) {
      limiter.fail(ip, now());
      res.status(401).type("html").send(loginPage("Wrong access code."));
      return;
    }
    res.setHeader(
      "Set-Cookie",
      cookie(req, AUTH_COOKIE, signAuth(opts.cookieSecret, now() + AUTH_TTL_MS), AUTH_TTL_MS),
    );
    res.redirect(303, "/");
  });

  // Everything below needs the auth cookie.
  app.use((req: Request, res: Response, next: NextFunction) => {
    if (authValid(opts.cookieSecret, parseCookies(req)[AUTH_COOKIE], now())) return next();
    if (req.path.startsWith("/api/")) {
      res.status(401).json({ error: "sign in first" });
      return;
    }
    res.redirect(302, "/login");
  });

  const sessionOf = (req: Request): Session | undefined =>
    sessions.get(parseCookies(req)[SESSION_COOKIE]);
  const startSession = (req: Request, res: Response): Session => {
    const s = sessions.create();
    res.setHeader("Set-Cookie", cookie(req, SESSION_COOKIE, s.id));
    return s;
  };
  const noStore = (res: Response) => res.setHeader("cache-control", "no-store");

  // The owner link for this visitor's engine. The dashboard moves the key into session storage.
  app.get("/", (req, res) => {
    const s = sessionOf(req) ?? startSession(req, res);
    noStore(res);
    res.redirect(302, `/demo#/?owner=${s.ownerToken}`);
  });

  app.get("/demo", (req, res) => {
    noStore(res);
    if (!sessionOf(req)) {
      res.redirect(302, "/");
      return;
    }
    if (!existsSync(index)) {
      res.status(503).type("text").send("dashboard not built: run pnpm build:hosted");
      return;
    }
    res.sendFile(index);
  });

  app.post("/api/reset", (req, res) => {
    const s = sessionOf(req);
    if (s) sessions.reset(s);
    else startSession(req, res);
    res.json({ ok: true });
  });

  app.use("/api", (req, res, next) => {
    const s = sessionOf(req);
    if (!s) {
      res.status(401).json({ error: "this demo session has ended: reload the page" });
      return;
    }
    s.engine.app(req, res, next);
  });

  app.use(express.static(opts.distDir, { index: false }));

  return { app, sessions, close: () => sessions.close() };
}
