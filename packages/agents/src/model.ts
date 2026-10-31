import Anthropic from "@anthropic-ai/sdk";
import type { AgentTask } from "@warrant/contracts";
import type { Brain, Propose } from "./brain.js";
import type { AgentContext } from "./context.js";
import { SYSTEM_PROMPTS, renderTask } from "./prompts.js";
import { TOOL_NAME, proposePaymentTool } from "./tool.js";

/** ADR-008: Haiku for the agents. Override with AGENT_MODEL. */
export const DEFAULT_AGENT_MODEL = "claude-haiku-4-5";

/**
 * One Messages API call. `key` names the call (role/task/turn) so record/replay can store and find
 * it without hashing the request. Real calls ignore it.
 */
export type CreateMessage = (
  params: Anthropic.MessageCreateParamsNonStreaming,
  key: string,
) => Promise<Anthropic.Message>;

/** The real API. The SDK reads ANTHROPIC_API_KEY itself; we never touch or log the key. */
export function anthropicCreate(client = new Anthropic()): CreateMessage {
  return (params) => client.messages.create(params);
}

export interface ModelBrainOptions {
  create: CreateMessage;
  model?: string;
  /** Model turns per task (each turn may call the tool). */
  maxTurns?: number;
}

/**
 * A model-driven agent: plain tool use with the one `propose_payment` tool (ADR-008, no agent
 * framework). The system prompt and tool are identical for every task of a role, so they are
 * marked for prompt caching; the task goes last.
 */
export class ModelBrain implements Brain {
  readonly name: string;
  private readonly model: string;
  private readonly maxTurns: number;

  constructor(private readonly opts: ModelBrainOptions) {
    this.model = opts.model ?? DEFAULT_AGENT_MODEL;
    this.maxTurns = opts.maxTurns ?? 4;
    this.name = `model:${this.model}`;
  }

  async act(task: AgentTask, ctx: AgentContext, propose: Propose): Promise<void> {
    const messages: Anthropic.MessageParam[] = [{ role: "user", content: renderTask(task, ctx) }];
    for (let turn = 1; turn <= this.maxTurns; turn++) {
      const res = await this.opts.create(
        {
          model: this.model,
          max_tokens: 1024,
          system: [
            { type: "text", text: SYSTEM_PROMPTS[ctx.role], cache_control: { type: "ephemeral" } },
          ],
          tools: [proposePaymentTool()],
          messages,
        },
        `${ctx.role}/${task.taskId}/${turn}`,
      );
      const uses = res.content.filter((b): b is Anthropic.ToolUseBlock => b.type === "tool_use");
      if (res.stop_reason !== "tool_use" || uses.length === 0) return;
      messages.push({ role: "assistant", content: res.content });
      const results: Anthropic.ToolResultBlockParam[] = [];
      for (const u of uses) {
        const text =
          u.name === TOOL_NAME
            ? await propose(u.input).catch((e: unknown) => `error: ${String(e)}`)
            : `unknown tool ${u.name}`;
        results.push({ type: "tool_result", tool_use_id: u.id, content: text });
      }
      messages.push({ role: "user", content: results });
    }
  }
}
