import { createHash, createHmac, timingSafeEqual } from "node:crypto";
import type { Request } from "express";

/**
 * Hosted demo sign-in: one shared access code (DEMO_PASSWORD). A correct code gets a cookie that
 * holds its own expiry, signed with DEMO_COOKIE_SECRET (HMAC-SHA256). Failed attempts are counted
 * per client address.
 */

export const AUTH_COOKIE = "warrant_demo_auth";
export const AUTH_TTL_MS = 7 * 24 * 60 * 60_000;

const sha = (s: string) => createHash("sha256").update(s).digest();

/** The access code matches. Both sides are hashed first, so the compare is constant time. */
export function codeMatches(given: string, want: string): boolean {
  return timingSafeEqual(sha(given), sha(want));
}

function mac(secret: string, expires: number): string {
  return createHmac("sha256", secret).update(`warrant-demo.${expires}`).digest("base64url");
}

/** Cookie value: `<expiry ms>.<signature>`. */
export function signAuth(secret: string, expires: number): string {
  return `${expires}.${mac(secret, expires)}`;
}

/** The cookie is ours and not expired. */
export function authValid(secret: string, value: string | undefined, now: number): boolean {
  const m = /^(\d{1,16})\.([A-Za-z0-9_-]{43})$/.exec(value ?? "");
  if (!m?.[1] || !m[2]) return false;
  const expires = Number(m[1]);
  const good = timingSafeEqual(Buffer.from(m[2]), Buffer.from(mac(secret, expires)));
  return good && expires > now;
}

/** Counts failed sign-ins per address in a fixed window. */
export class FailureLimiter {
  private readonly seen = new Map<string, { count: number; since: number }>();
  constructor(
    readonly limit = 10,
    readonly windowMs = 10 * 60_000,
  ) {}

  blocked(key: string, now: number): boolean {
    const s = this.seen.get(key);
    if (!s) return false;
    if (now - s.since >= this.windowMs) {
      this.seen.delete(key);
      return false;
    }
    return s.count >= this.limit;
  }

  fail(key: string, now: number): void {
    const s = this.seen.get(key);
    if (!s || now - s.since >= this.windowMs) this.seen.set(key, { count: 1, since: now });
    else s.count++;
    // Keep the table small: drop windows that have ended.
    if (this.seen.size > 5_000) {
      for (const [k, v] of this.seen) if (now - v.since >= this.windowMs) this.seen.delete(k);
    }
  }
}

export function parseCookies(req: Request): Record<string, string> {
  const out: Record<string, string> = {};
  for (const part of (req.get("cookie") ?? "").split(";")) {
    const i = part.indexOf("=");
    if (i < 1) continue;
    const k = part.slice(0, i).trim();
    const v = part.slice(i + 1).trim();
    try {
      out[k] = decodeURIComponent(v);
    } catch {
      out[k] = v;
    }
  }
  return out;
}

/** Secure when the visitor reached us over https (Render terminates TLS in front of us). */
export function isHttps(req: Request): boolean {
  return req.secure || req.get("x-forwarded-proto")?.split(",")[0]?.trim() === "https";
}

export function cookie(req: Request, name: string, value: string, maxAgeMs?: number): string {
  const parts = [`${name}=${value}`, "Path=/", "HttpOnly", "SameSite=Lax"];
  if (maxAgeMs !== undefined) parts.push(`Max-Age=${Math.floor(maxAgeMs / 1000)}`);
  if (isHttps(req)) parts.push("Secure");
  return parts.join("; ");
}

const escapeHtml = (s: string) => s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);

/** The sign-in page: one field, one button. Dashboard dark tokens and fonts; labels only. */
export function loginPage(message?: string): string {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="UTF-8" />
<meta name="viewport" content="width=device-width, initial-scale=1.0" />
<title>Warrant · sign in</title>
<link rel="preconnect" href="https://fonts.googleapis.com" />
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin />
<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Familjen+Grotesk:wght@500;600;700&family=JetBrains+Mono:wght@400;600&display=swap" />
<style>
:root {
  --bg: #0f1215; --panel: #171b1f; --sunk: #1e2328; --text: #e6e8e3; --muted: #9aa3ab;
  --line: #2a3036; --seal: #8fb3dc; --seal-bg: #1c2a3a; --stop: #ff7a70;
  --ui: "Familjen Grotesk", "Segoe UI", system-ui, -apple-system, sans-serif;
  --num: "JetBrains Mono", ui-monospace, "SF Mono", Consolas, monospace;
  color-scheme: dark;
}
* { box-sizing: border-box; }
body { margin: 0; min-height: 100vh; display: grid; place-items: center; padding: 16px;
  background: var(--bg); color: var(--text); font-family: var(--ui); line-height: 1.5; }
form { width: 100%; max-width: 340px; background: var(--panel); border: 1px solid var(--line);
  border-radius: 8px; padding: 24px; display: grid; gap: 12px; }
.brand { display: flex; align-items: center; gap: 10px; font-weight: 700; font-size: 1.1rem; }
.seal { display: inline-grid; place-items: center; width: 28px; height: 28px; border-radius: 50%;
  border: 1.5px solid var(--seal); color: var(--seal); background: var(--seal-bg);
  font: 600 0.85rem var(--num); }
label { font-size: 0.8rem; color: var(--muted); }
input { width: 100%; font: 400 1rem var(--num); padding: 10px 12px; border-radius: 8px;
  border: 1px solid var(--line); background: var(--sunk); color: var(--text); }
input:focus { outline: 2px solid var(--seal); outline-offset: 1px; }
button { font: 600 0.9rem var(--ui); padding: 10px 12px; border-radius: 8px; cursor: pointer;
  border: 1px solid var(--seal); background: var(--seal-bg); color: var(--text); }
.what { margin: 0; color: var(--muted); font-size: 0.85rem; }
.msg { margin: 0; color: var(--stop); font-size: 0.85rem; }
</style>
</head>
<body>
<form method="post" action="/login">
  <div class="brand"><span class="seal" aria-hidden="true">W</span>Warrant</div>
  <p class="what">Payment controls for AI agents · demo on simulated money</p>
  <label for="code">Access code</label>
  <input id="code" name="code" type="password" autocomplete="current-password" required autofocus />
  ${message ? `<p class="msg" role="alert">${escapeHtml(message)}</p>` : ""}
  <button type="submit">Sign in</button>
</form>
</body>
</html>
`;
}
