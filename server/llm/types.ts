// The narrow interface the agent loop talks to: "one streamed model turn, with
// tool calling". Two implementations: Anthropic (anthropic.ts) and a scripted
// fake (fake.ts). Nothing outside this folder knows which provider is in use.

import type { ChatBlock } from "../types.ts";

export type LlmBlock = ChatBlock;

export interface LlmToolResult {
  toolUseId: string;
  content: string;
  isError: boolean;
}

export type LlmMessage =
  | { role: "user"; text: string }
  | {
      role: "assistant";
      blocks: LlmBlock[];
      /**
       * What the provider returned for this turn, untouched, and who produced it.
       * A provider replays its own `raw` verbatim (this is what keeps thinking
       * blocks valid); anything else is rebuilt from `blocks`.
       */
      raw?: unknown;
      provider?: string;
    }
  | { role: "tool_results"; results: LlmToolResult[] };

export interface LlmToolDef {
  name: string;
  description: string;
  /** JSON Schema (type: "object"). */
  inputSchema: Record<string, unknown>;
}

export interface LlmTurnRequest {
  system: string;
  messages: LlmMessage[];
  tools: LlmToolDef[];
  /** Called with each piece of assistant text as it arrives. */
  onText?: (delta: string) => void;
  /** Called if the turn has to start over (text streamed so far must be discarded). */
  onRestart?: () => void;
  signal?: AbortSignal;
}

export type LlmStopReason = "end_turn" | "tool_use" | "max_tokens" | "refusal" | "other";

export interface LlmTurnResult {
  blocks: LlmBlock[];
  stopReason: LlmStopReason;
  /** Provider-native content to store and replay (see LlmMessage.raw). */
  raw?: unknown;
  usage?: { inputTokens: number; outputTokens: number };
  /** Human-readable note, e.g. why the model refused. */
  note?: string;
}

export interface LlmClient {
  readonly provider: "anthropic" | "fake";
  readonly model: string;
  /** null when usable; otherwise what the user has to fix (shown in the UI). */
  problem(): string | null;
  streamTurn(req: LlmTurnRequest): Promise<LlmTurnResult>;
}

/** An error whose message is fit to show to the user as-is. */
export class LlmError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "LlmError";
  }
}
