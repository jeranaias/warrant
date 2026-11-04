import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type Anthropic from "@anthropic-ai/sdk";
import { describe, expect, it } from "vitest";
import type { AgentTask, PaymentProposal } from "@warrant/contracts";
import { DEFAULT_AGENT_MAX_CALLS, brainFromEnv } from "./brains.js";
import type { AgentContext } from "./context.js";
import { loadDotEnv, positiveInt } from "./env.js";
import { ModelBrain, ModelCallLimit, limitCalls } from "./model.js";
import type { CreateMessage } from "./model.js";
import { runTask } from "./runner.js";
import type { ProposalOutcome } from "./runner.js";
import { counterIds } from "./tool.js";

/** Key handling and spending stops. Nothing here reaches the network. */

const msg = (n: number, stop: "tool_use" | "end_turn"): Anthropic.Message =>
  ({
    id: `msg_${n}`,
    type: "message",
    role: "assistant",
    model: "claude-haiku-4-5",
    content:
      stop === "tool_use"
        ? [
            {
              type: "tool_use",
              id: `toolu_${n}`,
              name: "propose_payment",
              input: {
                rail: "metal_x402",
                payeeId: "pay_upstream",
                amount: { currency: "USDZ", cents: 2 },
                category: "data_purchase",
                recurrence: "one_off",
                justification: "batch",
              },
            },
          ]
        : [{ type: "text", text: "done", citations: null }],
    stop_reason: stop,
    stop_sequence: null,
    usage: { input_tokens: 10, output_tokens: 5 },
  }) as Anthropic.Message;

describe(".env for pnpm agents and pnpm bench", () => {
  it("sets what is missing, never overrides, skips blanks, strips quotes", () => {
    const dir = mkdtempSync(join(tmpdir(), "agents-env-"));
    try {
      const file = join(dir, ".env");
      writeFileSync(
        file,
        [
          "# comment",
          "A_KEY=from-file",
          "ALREADY=from-file",
          "BLANK=",
          'QUOTED="q"',
          "lowercase=ignored",
        ].join("\n"),
      );
      const env: NodeJS.ProcessEnv = { ALREADY: "from-shell" };
      loadDotEnv(file, env);
      expect(env).toEqual({ ALREADY: "from-shell", A_KEY: "from-file", QUOTED: "q" });
      loadDotEnv(join(dir, "missing.env"), env);
      expect(Object.keys(env)).toHaveLength(3);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("caps must be whole numbers in range", () => {
    expect(positiveInt({}, "X", 7)).toBe(7);
    expect(positiveInt({ X: "12" }, "X", 7)).toBe(12);
    for (const bad of ["0", "-1", "1.5", "lots", "100001"]) {
      expect(() => positiveInt({ X: bad }, "X", 7), bad).toThrow(/X must be a whole number/);
    }
  });
});

describe("model call limit", () => {
  it("stops sending at the cap: the next call throws without reaching the API", async () => {
    let sent = 0;
    const inner: CreateMessage = () => {
      sent++;
      return Promise.resolve(msg(sent, "end_turn"));
    };
    const capped = limitCalls(inner, 2);
    const params = {} as Anthropic.MessageCreateParamsNonStreaming;
    await capped.create(params, "a");
    await capped.create(params, "b");
    await expect(capped.create(params, "c")).rejects.toBeInstanceOf(ModelCallLimit);
    expect(sent).toBe(2);
    expect(capped.usage()).toEqual({ calls: 2, max: 2 });
  });

  it("a task that hits the cap ends with the limit error and keeps what it proposed", async () => {
    const turns = [msg(1, "tool_use"), msg(2, "tool_use"), msg(3, "end_turn")];
    let i = 0;
    const capped = limitCalls(() => Promise.resolve(turns[i++] as Anthropic.Message), 2);
    const seen: PaymentProposal[] = [];
    const ctx: AgentContext = {
      role: "sourcing",
      agentId: "agt_sourcing",
      warrantId: "wrt_sourcing",
      purpose: "Buy upstream market data.",
      allowedRails: ["metal_x402"],
      payees: [
        {
          payeeId: "pay_upstream",
          displayName: "Upstream",
          rail: "metal_x402",
          currency: "USDZ",
        },
      ],
      orders: [],
    };
    const task: AgentTask = {
      kind: "data_offer",
      role: "sourcing",
      taskId: "task_cap",
      at: "2026-11-04T12:00:00Z",
      sourceRef: "src_cap",
      payeeId: "pay_upstream",
      item: "GET /forecast/eurusd",
      price: { currency: "USDZ", cents: 2 },
      content: "Batch available, 0.02 USDZ.",
    };
    const run = await runTask({
      brain: new ModelBrain({ create: capped.create }),
      task,
      ctx,
      submit: (p): Promise<ProposalOutcome> => {
        seen.push(p);
        return Promise.resolve({ status: "paid" });
      },
      ids: counterIds("cap"),
    });
    expect(run.error).toMatch(/model call limit reached \(2 calls\)/);
    expect(seen).toHaveLength(2);
    expect(capped.usage()).toEqual({ calls: 2, max: 2 });
  });
});

describe("brainFromEnv", () => {
  it("no key, or AGENT_BRAIN=scripted: the script, and no model calls to count", () => {
    expect(brainFromEnv({}).brain.name).toBe("scripted-naive");
    expect(brainFromEnv({}).usage()).toBeUndefined();
    const forced = brainFromEnv({ ANTHROPIC_API_KEY: "test-key", AGENT_BRAIN: "scripted" });
    expect(forced.brain.name).toBe("scripted-naive");
  });

  it("with a key: the model, capped at 100 calls unless the run or AGENT_MAX_CALLS says otherwise", () => {
    const env = { ANTHROPIC_API_KEY: "test-key" };
    const plain = brainFromEnv(env);
    expect(plain.brain.name).toMatch(/^model:/);
    expect(plain.usage()).toEqual({ calls: 0, max: DEFAULT_AGENT_MAX_CALLS });
    expect(brainFromEnv(env, { maxCalls: 2000 }).usage()).toEqual({ calls: 0, max: 2000 });
    expect(brainFromEnv({ ...env, AGENT_MAX_CALLS: "5" }, { maxCalls: 2000 }).usage()).toEqual({
      calls: 0,
      max: 5,
    });
    expect(() => brainFromEnv({ ...env, AGENT_MAX_CALLS: "0" })).toThrow(/AGENT_MAX_CALLS/);
  });
});
