// The agent loop: one user message in, model turns and tool calls until the
// model stops asking for tools. Everything is persisted as it happens, and the
// stored history is append-only (see llm/anthropic.ts for why that matters).

import type { ProjectStore } from "../store.ts";
import type { EventBus } from "../events.ts";
import { LlmError, type LlmClient, type LlmMessage } from "../llm/types.ts";
import { MIN_DURATION_SEC, MIN_REPAINT_SEC, type Studio } from "../studio.ts";
import type { ChatMessage, Selection, ToolResultRecord } from "../types.ts";
import { buildStudioState, buildSystemPrompt } from "./prompt.ts";
import { executeTool, toolDefinitions } from "./tools.ts";

/** A turn that needs more model calls than this is stuck in a loop. */
const MAX_MODEL_CALLS = 8;

export class AgentBusyError extends Error {}

export class Agent {
  private readonly studio: Studio;
  private readonly store: ProjectStore;
  private readonly bus: EventBus;
  private readonly llm: LlmClient;
  private readonly system: string;
  private readonly tools: ReturnType<typeof toolDefinitions>;
  private readonly turns = new Map<string, Promise<void>>();

  constructor(deps: { studio: Studio; llm: LlmClient }) {
    this.studio = deps.studio;
    this.store = deps.studio.store;
    this.bus = deps.studio.bus;
    this.llm = deps.llm;
    const max = deps.studio.config.maxDurationSec;
    this.system = buildSystemPrompt({ maxDurationSec: max, minDurationSec: MIN_DURATION_SEC, minRepaintSec: MIN_REPAINT_SEC });
    this.tools = toolDefinitions(max);
  }

  isBusy(projectId: string): boolean {
    return this.turns.has(projectId);
  }

  /** Resolves when the project's turn (if any) has finished. For tests and shutdown. */
  whenIdle(projectId: string): Promise<void> {
    return this.turns.get(projectId) ?? Promise.resolve();
  }

  /**
   * Accept a chat message: store it, start the turn in the background, return
   * the stored message at once. Progress arrives over the event bus.
   */
  send(projectId: string, text: string, selection: Selection | null): ChatMessage {
    this.studio.project(projectId);
    if (this.turns.has(projectId)) throw new AgentBusyError("The assistant is still answering the previous message.");

    this.repairHistory(projectId);
    const clean = this.studio.setSelection(projectId, selection);
    // The exact text the model sees is stored with the message, so that history replays identically.
    const llmText = `${text}\n\n${buildStudioState(this.studio.snapshot(projectId))}`;
    const message = this.store.insertMessage(projectId, { role: "user", text, selection: clean }, { text: llmText });
    this.bus.emit(projectId, { type: "chat.message", message });

    const turn = this.runTurn(projectId).finally(() => this.turns.delete(projectId));
    this.turns.set(projectId, turn);
    return message;
  }

  /** If a previous turn died between a tool call and its result, close the gap so the history is valid again. */
  private repairHistory(projectId: string): void {
    const stored = this.store.listStoredMessages(projectId).filter((s) => s.message.role !== "event");
    const last = stored[stored.length - 1]?.message;
    if (last?.role !== "assistant") return;
    const calls = last.blocks.filter((b) => b.type === "tool_use");
    if (!calls.length) return;
    const results: ToolResultRecord[] = calls.map((c) => ({
      toolUseId: c.id,
      name: c.name,
      content: JSON.stringify({ error: "This tool call was interrupted before it ran (the app was restarted). Nothing was done." }),
      isError: true,
    }));
    this.store.insertMessage(projectId, { role: "tool", results });
  }

  private history(projectId: string): LlmMessage[] {
    const out: LlmMessage[] = [];
    for (const { message: m, llm } of this.store.listStoredMessages(projectId)) {
      if (m.role === "user") {
        out.push({ role: "user", text: (llm as { text?: string } | null)?.text ?? m.text });
      } else if (m.role === "assistant") {
        const saved = llm as { provider?: string; content?: unknown } | null;
        out.push({ role: "assistant", blocks: m.blocks, raw: saved?.content, provider: saved?.provider });
      } else if (m.role === "tool") {
        out.push({ role: "tool_results", results: m.results.map((r) => ({ toolUseId: r.toolUseId, content: r.content, isError: r.isError })) });
      }
      // "event" messages are notes for the person; the model learns the same facts from <studio_state>.
    }
    return out;
  }

  private note(projectId: string, kind: "error" | "info", text: string): void {
    const message = this.store.insertMessage(projectId, { role: "event", kind, text });
    this.bus.emit(projectId, { type: "chat.message", message });
  }

  private async runTurn(projectId: string): Promise<void> {
    this.bus.emit(projectId, { type: "chat.turn", state: "started" });
    let failure: string | undefined;
    try {
      for (let call = 1; ; call++) {
        if (call > MAX_MODEL_CALLS) {
          this.note(projectId, "error", "The assistant kept calling tools without finishing, so this turn was stopped. Please try again.");
          break;
        }
        const result = await this.llm.streamTurn({
          system: this.system,
          tools: this.tools,
          messages: this.history(projectId),
          onText: (text) => this.bus.emit(projectId, { type: "chat.delta", text }),
          onRestart: () => this.bus.emit(projectId, { type: "chat.turn", state: "started" }),
        });

        if (result.stopReason === "refusal") {
          // Nothing from a refused turn is kept or executed.
          this.note(projectId, "error", result.note ?? "The chat model declined this request.");
          break;
        }

        const toolCalls = result.blocks.filter((b) => b.type === "tool_use");
        const assistant = this.store.insertMessage(
          projectId,
          { role: "assistant", blocks: result.blocks, stopReason: result.stopReason },
          { provider: this.llm.provider, model: this.llm.model, content: result.raw ?? null, usage: result.usage ?? null },
        );
        this.bus.emit(projectId, { type: "chat.message", message: assistant });
        if (!toolCalls.length) {
          if (result.stopReason === "max_tokens") this.note(projectId, "info", "The reply was cut off because it got too long.");
          break;
        }

        // A turn cut off at the token limit may carry a truncated tool input that still parses. Never run it.
        const truncated = result.stopReason !== "tool_use";
        const results: ToolResultRecord[] = [];
        for (const c of toolCalls) {
          const outcome = truncated
            ? { content: JSON.stringify({ error: "The reply was cut off before this tool call was complete, so it was not run." }), isError: true }
            : await executeTool(this.studio, projectId, this.tools, c.name, c.input);
          results.push({ toolUseId: c.id, name: c.name, content: outcome.content, isError: outcome.isError });
        }
        const toolMessage = this.store.insertMessage(projectId, { role: "tool", results });
        this.bus.emit(projectId, { type: "chat.message", message: toolMessage });
        if (truncated) {
          this.note(projectId, "error", "The assistant's reply was cut off mid-action, so nothing was started. Please try again.");
          break;
        }
      }
    } catch (err) {
      failure = err instanceof LlmError ? err.message : `The assistant failed: ${err instanceof Error ? err.message : String(err)}`;
      if (!(err instanceof LlmError)) console.error("[agent] turn failed:", err);
      this.note(projectId, "error", failure);
    } finally {
      this.bus.emit(projectId, { type: "chat.turn", state: "ended", ...(failure ? { error: failure } : {}) });
      this.bus.emit(projectId, { type: "state" });
    }
  }
}
