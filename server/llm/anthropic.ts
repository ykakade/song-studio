// Anthropic Messages API implementation of LlmClient, on the official SDK.
//
// Choices worth knowing about:
//  * Thinking is left at the model's default (adaptive). Current models reject
//    `thinking: disabled`; depth is steered with output_config.effort instead.
//  * The assistant's content blocks are stored and replayed verbatim (`raw`),
//    and history is append-only. Thinking blocks are only valid in the exact
//    conversation that produced them.
//  * Tool inputs are streamed eagerly, so the API does not validate them; the
//    agent loop validates every input against its schema before running a tool
//    and never runs tools from a turn that hit max_tokens or was refused.
//  * No forced tool_choice (rejected by current models).
//  * On the first-party API, declined requests are retried server-side on
//    Anthropic's default fallback model (`fallbacks: "default"`, a beta). This
//    is switched off behind a custom base URL, where a gateway may not know
//    the field. Same for eager input streaming and automatic prompt caching.
//
// Exercised against the real API on 2026-11-14 (text, tool calls, multi-turn
// replay). Refusal, max_tokens and gateway paths are only tested against the stub.

import Anthropic from "@anthropic-ai/sdk";
import type { Config } from "../config.ts";
import { LlmError, type LlmBlock, type LlmClient, type LlmMessage, type LlmStopReason, type LlmTurnRequest, type LlmTurnResult } from "./types.ts";

const FALLBACK_BETA = "server-side-fallback-2026-07-01";
const MAX_TOKENS = 32000;
const EFFORTS = new Set(["low", "medium", "high", "xhigh", "max"]);

type BetaStreamParams = Parameters<Anthropic["beta"]["messages"]["stream"]>[0];
type Effort = "low" | "medium" | "high" | "xhigh" | "max";

function toApiMessages(messages: LlmMessage[]): Anthropic.MessageParam[] {
  return messages.map((m): Anthropic.MessageParam => {
    if (m.role === "user") return { role: "user", content: m.text };
    if (m.role === "tool_results") {
      return {
        role: "user",
        content: m.results.map(
          (r): Anthropic.ToolResultBlockParam => ({ type: "tool_result", tool_use_id: r.toolUseId, content: r.content, is_error: r.isError || undefined }),
        ),
      };
    }
    if (m.provider === "anthropic" && Array.isArray(m.raw) && m.raw.length > 0) {
      return { role: "assistant", content: m.raw as Anthropic.ContentBlockParam[] };
    }
    const content: Anthropic.ContentBlockParam[] = m.blocks.map((b) =>
      b.type === "text" ? { type: "text", text: b.text } : { type: "tool_use", id: b.id, name: b.name, input: b.input },
    );
    return { role: "assistant", content: content.length ? content : [{ type: "text", text: "(no reply)" }] };
  });
}

function toStopReason(r: string | null): LlmStopReason {
  return r === "end_turn" || r === "tool_use" || r === "max_tokens" || r === "refusal" ? r : "other";
}

function explain(err: unknown, model: string): LlmError {
  if (err instanceof Anthropic.AuthenticationError) {
    return new LlmError("The chat model rejected the API key. Check ANTHROPIC_API_KEY in .env and restart the app.");
  }
  if (err instanceof Anthropic.PermissionDeniedError) {
    return new LlmError(`This API key is not allowed to use ${model}: ${err.message}`);
  }
  if (err instanceof Anthropic.NotFoundError) {
    return new LlmError(`The chat model "${model}" was not found. Check SONG_STUDIO_MODEL (and ANTHROPIC_BASE_URL if set).`);
  }
  if (err instanceof Anthropic.RateLimitError) {
    return new LlmError("The chat model is rate-limited right now. Wait a moment and send the message again.");
  }
  if (err instanceof Anthropic.BadRequestError) {
    return new LlmError(`The chat model rejected the request: ${err.message}`);
  }
  if (err instanceof Anthropic.APIConnectionError) {
    return new LlmError(`Could not reach the chat model API (${err.message}). Check the network connection.`);
  }
  if (err instanceof Anthropic.APIError) {
    return new LlmError(`The chat model API returned an error (${err.status ?? "no status"}): ${err.message}`);
  }
  if (err instanceof Anthropic.AnthropicError) {
    // Thrown by the client itself, e.g. when no credentials can be found.
    return new LlmError(`Chat model client error: ${err.message}`);
  }
  return new LlmError(`Unexpected chat model failure: ${err instanceof Error ? err.message : String(err)}`);
}

export class AnthropicLlm implements LlmClient {
  readonly provider = "anthropic" as const;
  readonly model: string;
  private readonly client: Anthropic;
  private readonly effort: Effort | null;
  private readonly firstParty: boolean;
  private readonly refusalFallback: boolean;
  private readonly hasCredentials: boolean;

  constructor(
    config: Pick<Config, "model" | "anthropicApiKey" | "anthropicBaseUrl" | "effort" | "refusalFallback">,
    /** Tests point the SDK at a local stub yet still want the first-party request shape. */
    overrides: { firstParty?: boolean } = {},
  ) {
    this.model = config.model;
    this.effort = config.effort && EFFORTS.has(config.effort) ? (config.effort as Effort) : null;
    this.firstParty = overrides.firstParty ?? !config.anthropicBaseUrl;
    this.refusalFallback = config.refusalFallback;
    this.hasCredentials = Boolean(config.anthropicApiKey || process.env.ANTHROPIC_AUTH_TOKEN);
    // The SDK reads ANTHROPIC_API_KEY / ANTHROPIC_BASE_URL from the environment itself;
    // passing them explicitly keeps this class testable with a Config object.
    this.client = new Anthropic({
      ...(config.anthropicApiKey ? { apiKey: config.anthropicApiKey } : {}),
      ...(config.anthropicBaseUrl ? { baseURL: config.anthropicBaseUrl } : {}),
    });
  }

  problem(): string | null {
    return this.hasCredentials
      ? null
      : "ANTHROPIC_API_KEY is not set. Add it to .env and restart the app (or set SONG_STUDIO_LLM=fake to try the app without a key).";
  }

  async streamTurn(req: LlmTurnRequest): Promise<LlmTurnResult> {
    const tools: Anthropic.Tool[] = req.tools.map((t) => ({
      name: t.name,
      description: t.description,
      input_schema: t.inputSchema as Anthropic.Tool.InputSchema,
      ...(this.firstParty ? { eager_input_streaming: true } : {}),
    }));
    const params: Anthropic.MessageStreamParams = {
      model: this.model,
      max_tokens: MAX_TOKENS,
      // The system prompt never changes between requests, so it caches well.
      system: [{ type: "text", text: req.system, cache_control: { type: "ephemeral" } }],
      tools,
      messages: toApiMessages(req.messages),
      ...(this.effort ? { output_config: { effort: this.effort } } : {}),
      // Automatic caching of the growing conversation prefix.
      ...(this.firstParty ? { cache_control: { type: "ephemeral" as const } } : {}),
    };

    // With eager input streaming, a tool input that is not parseable JSON makes
    // the stream reject with a non-API error. Only that case is retried.
    for (let attempt = 0; ; attempt++) {
      try {
        const message = await this.once(params, req);
        return this.toResult(message);
      } catch (err) {
        if (req.signal?.aborted) throw new LlmError("The request was cancelled.");
        if (err instanceof Anthropic.AnthropicError || attempt >= 2) throw explain(err, this.model);
        req.onRestart?.();
      }
    }
  }

  private async once(params: Anthropic.MessageStreamParams, req: LlmTurnRequest): Promise<Anthropic.Message | Anthropic.Beta.BetaMessage> {
    const options = { signal: req.signal };
    if (this.refusalFallback) {
      const stream = this.client.beta.messages.stream(
        { ...(params as unknown as BetaStreamParams), betas: [FALLBACK_BETA], fallbacks: "default" },
        options,
      );
      stream.on("text", (delta) => req.onText?.(delta));
      return await stream.finalMessage();
    }
    const stream = this.client.messages.stream(params, options);
    stream.on("text", (delta) => req.onText?.(delta));
    return await stream.finalMessage();
  }

  private toResult(message: Anthropic.Message | Anthropic.Beta.BetaMessage): LlmTurnResult {
    const stopReason = toStopReason(message.stop_reason);
    const usage = { inputTokens: message.usage.input_tokens, outputTokens: message.usage.output_tokens };
    if (stopReason === "refusal") {
      // A refusal can arrive before any output or cut a block off half-way: discard the content.
      const category = message.stop_details?.category;
      return {
        blocks: [],
        stopReason,
        usage,
        note: `The chat model declined this request${category ? ` (category: ${category})` : ""}. Try rephrasing it.`,
      };
    }
    const blocks: LlmBlock[] = [];
    for (const block of message.content) {
      if (block.type === "text") {
        if (block.text) blocks.push({ type: "text", text: block.text });
      } else if (block.type === "tool_use") {
        blocks.push({ type: "tool_use", id: block.id, name: block.name, input: block.input });
      }
      // thinking / redacted_thinking / fallback blocks are kept in `raw` only.
    }
    return { blocks, stopReason, raw: message.content, usage };
  }
}
