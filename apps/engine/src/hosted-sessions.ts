import { randomBytes } from "node:crypto";
import type { AgentDriver } from "./hosted-agents.js";
import type { Engine } from "./server.js";

/**
 * Hosted demo: one engine per visitor. A visitor is a random session id (a cookie); each session
 * has its own engine, mock world and owner key, so one visitor's approvals and STOP never reach
 * another's. At most `max` sessions live at once (the least recently used one goes first), and a
 * session idle for `idleMs` is dropped. With `startAgents`, each engine gets its own agents, stopped
 * when the session ends or resets.
 */

export interface Session {
  id: string;
  ownerToken: string;
  engine: Engine;
  agents?: AgentDriver;
  lastSeen: number;
}

export interface SessionOptions {
  /** Builds a fresh engine with this owner key (mock rails only). */
  makeEngine: (ownerToken: string) => Engine;
  /** Runs agents against a session's engine (the hosted demo); none when left out. */
  startAgents?: (engine: Engine) => AgentDriver;
  max?: number;
  idleMs?: number;
  /** How often idle sessions are swept; 0 turns the timer off (tests sweep by hand). */
  sweepMs?: number;
  now?: () => number;
}

const newId = () => randomBytes(24).toString("base64url");

export class SessionStore {
  readonly max: number;
  readonly idleMs: number;
  /** Insertion order is recency order: a touch moves the session to the end. */
  private readonly sessions = new Map<string, Session>();
  private readonly timer: NodeJS.Timeout | undefined;
  private readonly now: () => number;

  constructor(private readonly opts: SessionOptions) {
    this.max = opts.max ?? 25;
    this.idleMs = opts.idleMs ?? 20 * 60_000;
    this.now = opts.now ?? Date.now;
    const every = opts.sweepMs ?? 60_000;
    if (every > 0) {
      this.timer = setInterval(() => this.sweep(), every);
      this.timer.unref();
    }
  }

  get size(): number {
    return this.sessions.size;
  }

  /** The live session for this id, marked as just used; undefined if unknown or idle too long. */
  get(id: string | undefined): Session | undefined {
    if (!id) return undefined;
    const s = this.sessions.get(id);
    if (!s) return undefined;
    if (this.now() - s.lastSeen > this.idleMs) {
      this.drop(s);
      return undefined;
    }
    s.lastSeen = this.now();
    this.sessions.delete(id);
    this.sessions.set(id, s);
    return s;
  }

  /** A new session with a fresh engine. Evicts the least recently used one when full. */
  create(): Session {
    this.sweep();
    while (this.sessions.size >= this.max) {
      const oldest = this.sessions.keys().next();
      if (oldest.done) break;
      const s = this.sessions.get(oldest.value);
      if (s) this.drop(s);
      else this.sessions.delete(oldest.value);
    }
    const ownerToken = newId();
    const s: Session = {
      id: newId(),
      ownerToken,
      ...this.engineFor(ownerToken),
      lastSeen: this.now(),
    };
    this.sessions.set(s.id, s);
    return s;
  }

  /** Same visitor, same owner key, a fresh engine. */
  reset(s: Session): Session {
    s.agents?.stop();
    const fresh = this.engineFor(s.ownerToken);
    s.engine = fresh.engine;
    if (fresh.agents) s.agents = fresh.agents;
    else delete s.agents;
    s.lastSeen = this.now();
    return s;
  }

  /** Drops every session idle longer than `idleMs`. */
  sweep(): void {
    const cutoff = this.now() - this.idleMs;
    for (const s of this.sessions.values()) if (s.lastSeen < cutoff) this.drop(s);
  }

  close(): void {
    if (this.timer) clearInterval(this.timer);
    for (const s of this.sessions.values()) s.agents?.stop();
    this.sessions.clear();
  }

  private engineFor(ownerToken: string): Pick<Session, "engine" | "agents"> {
    const engine = this.opts.makeEngine(ownerToken);
    const agents = this.opts.startAgents?.(engine);
    return agents ? { engine, agents } : { engine };
  }

  private drop(s: Session): void {
    s.agents?.stop();
    this.sessions.delete(s.id);
  }
}
