import { existsSync } from "node:fs";
import { join } from "node:path";
import express from "express";
import type { Express, NextFunction, Request, Response } from "express";
import {
  AUTH_COOKIE,
  AUTH_TTL_MS,
  FailureLimiter,
  authValid,
  busyPage,
  codeMatches,
  cookie,
  isHttps,
  loginPage,
  parseCookies,
  signAuth,
} from "./hosted-auth.js";
import { anthropicClients, keyProblem, modelStatus, sessionModel } from "./hosted-model.js";
import type { ModelClientFactory } from "./hosted-model.js";
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
 *   POST /api/reset    a fresh engine for this visitor (scripted agents again)
 *   GET  /api/model    what this visitor's agents run on: scripted, or the model on their own key
 *   POST /api/model-key   {key}: run this visitor's agents and purpose check on their own key
 *   DELETE /api/model-key  forget it (ADR-023)
 *   ANY  /api/...      this visitor's engine (the same routes as `pnpm engine`)
 *
 * Every response carries security headers (CSP, no framing by other sites, no sniffing, no
 * referrer, HSTS over https). A POST from another site is refused (Origin / Sec-Fetch-Site), on
 * top of the SameSite cookies. Errors never echo a stack.
 */

export const SESSION_COOKIE = "warrant_demo_session";

export interface HostedOptions extends SessionOptions {
  password: string;
  cookieSecret: string;
  /** The built dashboard (apps/dashboard/dist). */
  distDir: string;
  limiter?: FailureLimiter;
  /**
   * Proxy hops in front of us whose X-Forwarded-For entries we trust (Render: 1). The client
   * address is the entry the nearest trusted proxy added, so a client can't pick its own.
   */
  trustProxyHops?: number;
  /**
   * A header the edge sets to the client address and overwrites when a client sends it (Render's
   * Cloudflare edge: `cf-connecting-ip`). Used before X-Forwarded-For when present.
   */
  clientIpHeader?: string;
  /** Builds the model clients for a pasted key (ADR-023). Tests pass fakes; never the network. */
  modelClients?: ModelClientFactory;
  /** Bad key attempts per client address, so the key check can't be used to test keys at scale. */
  keyLimiter?: FailureLimiter;
}

/** The built dashboard loads its own scripts and Google Fonts; React sets inline styles. */
export const CSP = [
  "default-src 'self'",
  "script-src 'self'",
  "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com",
  "font-src 'self' https://fonts.gstatic.com",
  "img-src 'self' data:",
  "connect-src 'self'",
  "object-src 'none'",
  "base-uri 'none'",
  "form-action 'self'",
  "frame-ancestors 'self'",
].join("; ");

/** A state-changing request that came from another site. */
function crossSite(req: Request): boolean {
  // Browsers that send Sec-Fetch-Site are trusted on it: a same-origin form post can still carry
  // "Origin: null" (Chrome does under a strict referrer policy), so the origin decides only when
  // that header is absent.
  const site = req.get("sec-fetch-site");
  if (site) return site !== "same-origin" && site !== "none";
  const origin = req.get("origin");
  if (!origin) return false;
  try {
    return new URL(origin).host !== req.get("host");
  } catch {
    return true;
  }
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
  const keyLimiter = opts.keyLimiter ?? new FailureLimiter();
  const modelClients = opts.modelClients ?? anthropicClients;
  const index = join(opts.distDir, "index.html");
  /** Who is asking, for the sign-in limit and the per-address session cap. */
  const clientOf = (req: Request): string =>
    (opts.clientIpHeader && req.get(opts.clientIpHeader)?.trim()) || req.ip || "unknown";

  const app = express();
  app.disable("x-powered-by");
  // Render terminates TLS in front of us. Trust only its hop: `true` would let a client choose its
  // own address with a forged X-Forwarded-For and walk around the sign-in limit.
  app.set("trust proxy", opts.trustProxyHops ?? 1);

  app.use((req, res, next) => {
    res.setHeader("content-security-policy", CSP);
    res.setHeader("x-content-type-options", "nosniff");
    res.setHeader("x-frame-options", "SAMEORIGIN");
    res.setHeader("referrer-policy", "same-origin");
    res.setHeader("cross-origin-opener-policy", "same-origin");
    res.setHeader("permissions-policy", "camera=(), microphone=(), geolocation=()");
    if (isHttps(req)) res.setHeader("strict-transport-security", "max-age=15552000");
    next();
  });

  app.use((req, res, next) => {
    if (req.method === "GET" || req.method === "HEAD" || !crossSite(req)) return next();
    res.status(403).json({ error: "cross-site request refused" });
  });

  app.get("/api/health", (_req, res) => {
    res.json({ ok: true });
  });

  app.get("/login", (_req, res) => {
    res.type("html").send(loginPage());
  });

  app.post("/login", express.urlencoded({ extended: false, limit: "2kb" }), (req, res) => {
    const ip = clientOf(req);
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
  /** A new session for this visitor, or undefined when every seat is in use. */
  const startSession = (req: Request, res: Response): Session | undefined => {
    const s = sessions.create(clientOf(req));
    if (s) res.setHeader("Set-Cookie", cookie(req, SESSION_COOKIE, s.id));
    return s;
  };
  const busy = (res: Response) => {
    res.setHeader("retry-after", "60");
    res.status(503).type("html").send(busyPage());
  };
  const noStore = (res: Response) => res.setHeader("cache-control", "no-store");

  // The owner link for this visitor's engine. The dashboard moves the key into session storage.
  app.get("/", (req, res) => {
    const s = sessionOf(req) ?? startSession(req, res);
    noStore(res);
    if (!s) {
      busy(res);
      return;
    }
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
    // With `root`, only the part under it is checked for dot segments: a full path through a dot
    // folder (~/.dev/warrant) would be refused with a 404.
    res.sendFile("index.html", { root: opts.distDir });
  });

  app.post("/api/reset", (req, res) => {
    const s = sessionOf(req);
    if (s) sessions.reset(s);
    else if (!startSession(req, res)) {
      res.setHeader("retry-after", "60");
      res.status(503).json({ error: "the demo is full right now: try again in a minute" });
      return;
    }
    res.json({ ok: true });
  });

  // A visitor's own Anthropic key (ADR-023). Held only inside that session's model clients: never
  // stored, logged or sent back, and no error from the API is passed on (it could quote the key).
  app.get("/api/model", (req, res) => {
    const s = sessionOf(req);
    noStore(res);
    if (!s) {
      res.status(401).json({ error: "this demo session has ended: reload the page" });
      return;
    }
    res.json(modelStatus(s.model));
  });

  app.post("/api/model-key", express.json({ limit: "1kb" }), async (req, res) => {
    const s = sessionOf(req);
    noStore(res);
    if (!s) {
      res.status(401).json({ error: "this demo session has ended: reload the page" });
      return;
    }
    const ip = clientOf(req);
    if (keyLimiter.blocked(ip, now())) {
      res.status(429).json({ error: "too many key attempts: try again in 10 minutes" });
      return;
    }
    const key: unknown = (req.body as { key?: unknown } | undefined)?.key;
    const problem = keyProblem(key);
    if (problem || typeof key !== "string") {
      keyLimiter.fail(ip, now());
      res.status(400).json({ error: problem ?? "paste an Anthropic API key" });
      return;
    }
    let clients: ReturnType<ModelClientFactory>;
    try {
      clients = modelClients(key.trim());
      await clients.verify();
    } catch {
      keyLimiter.fail(ip, now());
      res.status(400).json({ error: "Anthropic did not accept this key" });
      return;
    }
    sessions.useModel(s, sessionModel(clients));
    res.json(modelStatus(s.model));
  });

  app.delete("/api/model-key", (req, res) => {
    const s = sessionOf(req);
    noStore(res);
    if (!s) {
      res.status(401).json({ error: "this demo session has ended: reload the page" });
      return;
    }
    if (s.model) sessions.useModel(s, undefined);
    res.json(modelStatus(s.model));
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

  // Last: never send a stack trace (Express's default handler does outside production).
  app.use((err: unknown, _req: Request, res: Response, next: NextFunction) => {
    if (res.headersSent) return next(err);
    const status = (err as { status?: unknown }).status;
    const code = typeof status === "number" && status >= 400 && status < 500 ? status : 500;
    if (code === 500) console.error("hosted demo error:", err);
    res.status(code).json({ error: code === 500 ? "something went wrong" : "bad request" });
  });

  return { app, sessions, close: () => sessions.close() };
}
