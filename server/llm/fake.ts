// A scripted stand-in for the chat model. It lets the whole app run, and be
// tested end to end, without an API key. It is NOT intelligent: it recognises a
// handful of phrasings with regular expressions and answers from templates.
//
// Two ways to drive it:
//   * rules (default): behaves like a very literal assistant, see `decide()`
//   * script: tests can pass an explicit list of turns to return, one per call
//
// It follows the same contract the real model is asked to follow in the system
// prompt, including the important one: it never invents a time range.

import { randomBytes } from "node:crypto";
import { countSungWords, wordBudget } from "../lyrics.ts";
import type { LlmBlock, LlmClient, LlmMessage, LlmToolResult, LlmTurnRequest, LlmTurnResult } from "./types.ts";

export interface FakeTurn {
  text?: string;
  toolCalls?: Array<{ name: string; input: unknown }>;
}
export type ScriptedTurn = FakeTurn | ((req: LlmTurnRequest) => FakeTurn);

export interface FakeLlmOptions {
  /** Delay between streamed words. Default 12 ms; tests use 0. */
  wordDelayMs?: number;
  /** If given, these turns are returned in order instead of using the rules. */
  script?: ScriptedTurn[];
}

interface StudioContext {
  currentTakeId: string | null;
  selection: { start: number; end: number } | null;
  markers: Array<{ label: string; start: number; end: number }>;
}

const DEMO_VERSE = [
  "Paper boats along the gutter stream",
  "Carrying the light of a half-remembered dream",
  "Every window holds a different sky",
  "We wave at all the strangers passing by",
];
const DEMO_CHORUS = "[chorus]\nHold on, hold on, the morning's on its way\nHold on, hold on, we'll sing the dark away";
const DEMO_OUTRO = "[outro]\nHold on, hold on";

/** The demo song, with as many verse lines as the studio's word budget allows. */
function demoLyrics(durationSec: number, bpm: number): string {
  for (let n = DEMO_VERSE.length; n >= 1; n--) {
    const lyrics = [`[verse]\n${DEMO_VERSE.slice(0, n).join("\n")}`, DEMO_CHORUS, DEMO_OUTRO].join("\n\n");
    if (countSungWords(lyrics) <= wordBudget(durationSec, bpm)) return lyrics;
  }
  const short = `[verse]\n${DEMO_VERSE[0]}\n\n${DEMO_CHORUS}`;
  return countSungWords(short) <= wordBudget(durationSec, bpm) ? short : `[verse]\n${DEMO_VERSE[0]}\n\n${DEMO_OUTRO}`;
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

/** Reads the <studio_state> block the app appends to every user message. */
export function parseStudioContext(text: string): StudioContext {
  const block = /<studio_state>([\s\S]*?)<\/studio_state>/.exec(text)?.[1] ?? "";
  const line = (name: string) => new RegExp(`^${name}:\\s*(.*)$`, "m").exec(block)?.[1]?.trim() ?? "";
  const take = /\b(t_[0-9a-f]+)\b/.exec(line("current take"))?.[1] ?? null;
  const sel = /(\d+(?:\.\d+)?)\s*[–-]\s*(\d+(?:\.\d+)?)/.exec(line("selection on the waveform"));
  const markers: StudioContext["markers"] = [];
  for (const m of line("section markers").matchAll(/"([^"]+)"\s+(\d+(?:\.\d+)?)\s*[–-]\s*(\d+(?:\.\d+)?)/g)) {
    markers.push({ label: m[1], start: Number(m[2]), end: Number(m[3]) });
  }
  return { currentTakeId: take, selection: sel ? { start: Number(sel[1]), end: Number(sel[2]) } : null, markers };
}

function userWords(text: string): string {
  return text.replace(/<studio_state>[\s\S]*?<\/studio_state>/g, "").trim();
}

function lastUser(messages: LlmMessage[]): string {
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i];
    if (m.role === "user") return m.text;
  }
  return "";
}

type Intent =
  | { kind: "generate" }
  | { kind: "add_sound"; sound: string; range: { start: number; end: number } | null }
  | { kind: "remove_sound"; instrument: string }
  | { kind: "markers"; label: string; start: number; end: number }
  | { kind: "revert" }
  | { kind: "edit"; range: { source: "selection" | "marker" | "user_stated"; start: number; end: number; label?: string } }
  | { kind: "edit_needs_range" }
  | { kind: "chat" };

const EDIT_WORDS = /\b(change|rewrite|redo|repaint|replace|make|turn|fix|swap|remove|add|different|new lyrics|solo|instrumental)\b/i;

/** Words that name a library sound, most specific first. */
const SOUND_WORDS: Array<[RegExp, string]> = [
  [/four[ -]on[ -]the[ -]floor|dance beat/i, "drums.four-on-the-floor"],
  [/half[ -]?time/i, "drums.half-time"],
  [/\b(drums?|drum (?:sound|beat|loop)|beat)\b/i, "drums.backbeat"],
  [/\bshakers?\b/i, "percussion.shaker"],
  [/\bclaps?\b/i, "percussion.claps"],
  [/\b(crash|cymbal)\b/i, "percussion.crash"],
  [/\bbass\b/i, "bass.pulse"],
  [/\bpicked\b/i, "guitar.picked"],
  [/\bguitars?\b/i, "guitar.strum"],
  [/\b(piano|keys|keyboard)\b/i, "keys.piano"],
  [/\b(pad|strings)\b/i, "keys.pad"],
];

function classify(text: string): Intent {
  const ctx = parseStudioContext(text);
  const words = userWords(text);
  const range = /(?:from\s+)?(\d+(?:\.\d+)?)\s*(?:s|sec|seconds)?\s*(?:to|-|–|until)\s*(\d+(?:\.\d+)?)\s*(?:s|sec|seconds)?/i.exec(words);

  const marker = /(?:the\s+)?([a-z][a-z0-9 ]{1,30}?)\s+(?:is|runs|goes|starts)\s+(?:at\s+|from\s+)?(\d+(?:\.\d+)?)\s*(?:s|sec|seconds)?\s*(?:to|-|–|until)\s*(\d+(?:\.\d+)?)/i.exec(words);
  if (marker && ctx.currentTakeId) return { kind: "markers", label: marker[1].trim(), start: Number(marker[2]), end: Number(marker[3]) };

  if (/\b(revert|go back|undo|previous take)\b/i.test(words) && ctx.currentTakeId) return { kind: "revert" };

  // Layered sounds: "add drums", "put a shaker on the part I selected", "remove the drums".
  const sound = SOUND_WORDS.find(([re]) => re.test(words))?.[1];
  if (sound && ctx.currentTakeId && !/\b(solo|new song|start over|from scratch|another song)\b/i.test(words)) {
    if (/\b(remove|delete|take (?:off|out|away)|get rid of)\b/i.test(words)) return { kind: "remove_sound", instrument: sound.split(".")[0] };
    if (/\b(add|put|layer|drop|give)\b/i.test(words)) {
      return { kind: "add_sound", sound, range: ctx.selection ?? (range ? { start: Number(range[1]), end: Number(range[2]) } : null) };
    }
  }
  if (!ctx.currentTakeId || /\b(new song|start over|from scratch|another song)\b/i.test(words)) {
    return /\b(song|track|tune|write|make|generate|compose|create)\b/i.test(words) ? { kind: "generate" } : { kind: "chat" };
  }
  if (EDIT_WORDS.test(words)) {
    if (ctx.selection) return { kind: "edit", range: { source: "selection", ...ctx.selection } };
    const named = ctx.markers.find((m) => words.toLowerCase().includes(m.label.toLowerCase()));
    if (named) return { kind: "edit", range: { source: "marker", start: named.start, end: named.end, label: named.label } };
    if (range) return { kind: "edit", range: { source: "user_stated", start: Number(range[1]), end: Number(range[2]) } };
    return { kind: "edit_needs_range" };
  }
  return { kind: "chat" };
}

function demoSong(words: string) {
  const duration = Number(/(\d+)\s*(?:s\b|sec|seconds)/i.exec(words)?.[1] ?? 30);
  const bpm = Number(/(\d+)\s*bpm/i.exec(words)?.[1] ?? 110);
  const about = /\babout\s+(.{3,60}?)(?:[.,!?]|$)/i.exec(words)?.[1];
  const title = about ? about.replace(/^(a|an|the)\s+/i, "").replace(/\b\w/g, (c) => c.toUpperCase()) : "Paper Boats";
  const durationSec = Math.max(10, Math.min(120, duration));
  return {
    title,
    style_prompt: words.replace(/\s+/g, " ").slice(0, 300) || "warm indie folk, acoustic guitar, clear upfront lead vocal, crisp diction",
    lyrics: demoLyrics(durationSec, bpm),
    bpm,
    key: "C Major",
    duration_seconds: durationSec,
  };
}

/** A blunt lyric edit so that a repaint visibly changes the lyrics panel. */
function editLyrics(lyrics: string, words: string, n: number): { lyrics: string; style?: string; summary: string } {
  const sections = lyrics.split(/\n\s*\n/);
  const idx = Math.max(0, sections.findIndex((s) => /^\[chorus\]/i.test(s.trim())));
  if (/\b(solo|instrumental)\b/i.test(words)) {
    sections[idx] = "[guitar solo]";
    return { lyrics: sections.join("\n\n"), style: "expressive electric guitar solo", summary: "Turned the selected part into a guitar solo" };
  }
  const tag = /^\[[^\]]+\]/.exec(sections[idx].trim())?.[0] ?? "[chorus]";
  sections[idx] = `${tag}\nNew words for the part you picked (edit ${n})\nEverything around them stays the same`;
  return { lyrics: sections.join("\n\n"), summary: "Rewrote the lyrics in the selected part" };
}

function parseResult(r: LlmToolResult): any {
  try {
    return JSON.parse(r.content);
  } catch {
    return { error: r.content };
  }
}

function decide(req: LlmTurnRequest): FakeTurn {
  const messages = req.messages;
  const last = messages[messages.length - 1];
  const userText = lastUser(messages);
  const words = userWords(userText);
  const intent = classify(userText);

  if (last?.role === "tool_results") {
    const prev = messages[messages.length - 2];
    const calls = prev?.role === "assistant" ? prev.blocks.filter((b): b is Extract<LlmBlock, { type: "tool_use" }> => b.type === "tool_use") : [];
    const call = calls[0];
    const result = last.results[0];
    const data = result ? parseResult(result) : {};
    if (!call || !result) return { text: "Something went wrong on my side; please try again." };
    if (result.isError) return { text: `That didn't work: ${data.error ?? result.content}` };

    if (call.name === "get_project_state") {
      const cur = data.current_take;
      if (intent.kind === "edit" && cur) {
        const edit = editLyrics(cur.lyrics ?? "", words, (data.takes?.length ?? 0) + 1);
        return {
          toolCalls: [
            {
              name: "repaint_section",
              input: {
                take_id: cur.id,
                start_seconds: intent.range.start,
                end_seconds: intent.range.end,
                range_source: intent.range.source,
                ...(intent.range.label ? { marker_label: intent.range.label } : {}),
                lyrics: edit.lyrics,
                ...(edit.style ? { style_prompt: `${cur.style_prompt}, ${edit.style}` } : {}),
                change_summary: edit.summary,
              },
            },
          ],
        };
      }
      if (intent.kind === "markers") {
        const keep = (data.section_markers ?? []).filter((m: any) => m.label.toLowerCase() !== intent.label.toLowerCase());
        return {
          toolCalls: [
            {
              name: "set_section_markers",
              input: { markers: [...keep, { label: intent.label, start_seconds: intent.start, end_seconds: intent.end }] },
            },
          ],
        };
      }
      if (intent.kind === "remove_sound") {
        const clips: any[] = (data.timeline?.tracks ?? []).flatMap((t: any) => t.clips ?? []);
        const clip = clips.find((c) => String(c.sound).startsWith(intent.instrument));
        if (!clip) return { text: `There is no ${intent.instrument} sound on the timeline.` };
        return { toolCalls: [{ name: "remove_sound", input: { clip_id: clip.clip_id } }] };
      }
      if (intent.kind === "revert") {
        const takes: any[] = data.takes ?? [];
        const byId = /\b(t_[0-9a-f]+)\b/.exec(words)?.[1];
        const byNumber = /\btake\s+(\d+)\b/i.exec(words)?.[1];
        const target = byId ?? takes.find((t) => String(t.number) === byNumber)?.id ?? cur?.parent_take_id;
        if (!target) return { text: "There is no earlier take to go back to." };
        return { toolCalls: [{ name: "revert_to_take", input: { take_id: target } }] };
      }
      return { text: cur ? `The current take is take ${cur.number} (“${cur.title}”, ${cur.duration_seconds} s).` : "There is no song yet. Tell me what to write." };
    }
    if (call.name === "generate_song") {
      return { text: `I've started generating “${(call.input as any).title}”. It takes about a minute; the waveform will appear here when it's ready.` };
    }
    if (call.name === "repaint_section") {
      const i = call.input as any;
      return {
        text: `I've started a new take that changes only ${Number(i.start_seconds).toFixed(1)}–${Number(i.end_seconds).toFixed(1)} s. Everything outside that range stays exactly as it is. About a minute.`,
      };
    }
    if (call.name === "add_sound") {
      const c = data.clip ?? {};
      return {
        text: `Added ${c.sound} on the “${c.track}” track, ${Number(c.start_seconds).toFixed(1)}–${Number(c.end_seconds).toFixed(1)} s. It plays with the song now; drag the clip on the timeline to move it.`,
      };
    }
    if (call.name === "remove_sound") return { text: "Removed it from the timeline. The song itself is unchanged." };
    if (call.name === "set_section_markers") {
      const list = (data.section_markers ?? []).map((m: any) => `${m.label} ${m.start_seconds}–${m.end_seconds} s`).join(", ");
      return { text: `Saved. Markers now: ${list || "none"}.` };
    }
    if (call.name === "revert_to_take") return { text: `Done. Take ${data.current_take?.number ?? ""} is the current take again.`.replace("  ", " ") };
    return { text: "Done." };
  }

  switch (intent.kind) {
    case "generate":
      return { toolCalls: [{ name: "generate_song", input: demoSong(words) }] };
    case "add_sound":
      return {
        toolCalls: [
          { name: "add_sound", input: { sound: intent.sound, ...(intent.range ? { start_seconds: intent.range.start, end_seconds: intent.range.end } : {}) } },
        ],
      };
    case "edit":
    case "markers":
    case "revert":
    case "remove_sound":
      return { toolCalls: [{ name: "get_project_state", input: {} }] };
    case "edit_needs_range":
      return {
        text: "Which part should I change? Drag across it on the waveform to select it, then send your request again. If you tell me what the part is (for example “this is the chorus”), I'll save it as a marker so you can refer to it by name next time.",
      };
    default:
      return {
        text: "I'm the scripted demo assistant (no real language model is connected). Try: “write a 30 second folk song about paper boats”, then select a range on the waveform and say “rewrite the lyrics in the part I selected”, or “add drums”.",
      };
  }
}

export class FakeLlm implements LlmClient {
  readonly provider = "fake" as const;
  readonly model = "scripted-fake";
  private readonly wordDelayMs: number;
  private readonly script: ScriptedTurn[] | null;
  /** Every request received, for assertions in tests. */
  readonly requests: LlmTurnRequest[] = [];

  constructor(opts: FakeLlmOptions = {}) {
    this.wordDelayMs = opts.wordDelayMs ?? 12;
    this.script = opts.script ? [...opts.script] : null;
  }

  problem(): string | null {
    return null;
  }

  async streamTurn(req: LlmTurnRequest): Promise<LlmTurnResult> {
    this.requests.push({ ...req, messages: structuredClone(req.messages) });
    let turn: FakeTurn;
    if (this.script) {
      const next = this.script.shift();
      if (!next) throw new Error("FakeLlm: the script has no more turns");
      turn = typeof next === "function" ? next(req) : next;
    } else {
      turn = decide(req);
    }

    const blocks: LlmBlock[] = [];
    if (turn.text) {
      for (const piece of turn.text.match(/\S+\s*/g) ?? []) {
        if (req.signal?.aborted) break;
        req.onText?.(piece);
        if (this.wordDelayMs > 0) await sleep(this.wordDelayMs);
      }
      blocks.push({ type: "text", text: turn.text });
    }
    for (const call of turn.toolCalls ?? []) {
      blocks.push({ type: "tool_use", id: `fake_${randomBytes(6).toString("hex")}`, name: call.name, input: call.input });
    }
    return {
      blocks,
      stopReason: turn.toolCalls?.length ? "tool_use" : "end_turn",
      raw: blocks,
      usage: { inputTokens: 0, outputTokens: 0 },
    };
  }
}
