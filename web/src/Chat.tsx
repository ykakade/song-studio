import { ArrowUp, Check, CircleX, CornerDownRight, Info, LoaderCircle, X } from "lucide-react";
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import type { ChatMessage, Health, Job, Selection, Take } from "./api.ts";
import { fmtRange } from "./api.ts";
import { llmLabel } from "./ProjectList.tsx";

const icon = { size: 14, strokeWidth: 1.5 } as const;

type ToolUse = { type: "tool_use"; id: string; name: string; input: any };
type ToolResult = { toolUseId: string; name: string; content: string; isError: boolean };

const num = (v: unknown, digits = 1) => (typeof v === "number" ? v.toFixed(digits) : "?");

/** One readable line per tool call, instead of raw JSON. */
function describeTool(use: ToolUse): { title: string; detail: string } {
  const i = use.input ?? {};
  switch (use.name) {
    case "generate_song":
      return { title: "Generate a new song", detail: [`“${i.title ?? "Untitled"}”`, `${i.duration_seconds ?? "?"} s`, `${i.bpm ?? "?"} bpm`, i.key].filter(Boolean).join(" · ") };
    case "repaint_section":
      return { title: `Repaint ${num(i.start_seconds)}–${num(i.end_seconds)} s`, detail: i.change_summary ?? "" };
    case "get_project_state":
      return { title: "Read the project", detail: "" };
    case "set_section_markers":
      return {
        title: "Save section markers",
        detail: Array.isArray(i.markers) ? i.markers.map((m: any) => `${m.label} ${num(m.start_seconds)}–${num(m.end_seconds)} s`).join(", ") : "",
      };
    case "add_sound":
      return {
        title: "Add a sound to the timeline",
        detail: [i.sound, typeof i.start_seconds === "number" || typeof i.end_seconds === "number" ? `${num(i.start_seconds)}–${num(i.end_seconds)} s` : "whole song"].filter(Boolean).join(" · "),
      };
    case "update_sound":
      return { title: "Change a sound on the timeline", detail: String(i.clip_id ?? "") };
    case "remove_sound":
      return { title: "Remove a sound from the timeline", detail: String(i.clip_id ?? "") };
    case "set_track":
      return { title: i.muted === true ? "Mute a track" : i.muted === false ? "Unmute a track" : "Change a track", detail: String(i.name ?? i.track_id ?? "") };
    case "revert_to_take":
      return { title: "Switch to an earlier take", detail: String(i.take_id ?? "") };
    default:
      return { title: use.name, detail: "" };
  }
}

function ToolRow({ use, result, running }: { use: ToolUse; result: ToolResult | undefined; running: boolean }) {
  const { title, detail } = describeTool(use);
  let error: string | null = null;
  if (result?.isError) {
    try {
      error = JSON.parse(result.content).error ?? result.content;
    } catch {
      error = result.content;
    }
  }
  const state = result ? (result.isError ? "error" : "ok") : running ? "running" : "pending";
  return (
    <details className={`tool tool-${state}`} data-testid="tool-call" data-tool={use.name} data-state={state}>
      <summary>
        <span className="tool-icon" aria-hidden="true">
          {state === "ok" ? <Check {...icon} /> : state === "error" ? <CircleX {...icon} /> : <LoaderCircle {...icon} className="spin" />}
        </span>
        <span className="tool-title">{title}</span>
        {detail && <span className="tool-detail">{detail}</span>}
      </summary>
      {error && <div className="tool-error-text">{error}</div>}
      <div className="tool-body">
        <div className="tool-label">input</div>
        <pre>{JSON.stringify(use.input, null, 2)}</pre>
        {result && (
          <>
            <div className="tool-label">result</div>
            <pre>{prettyJson(result.content)}</pre>
          </>
        )}
      </div>
    </details>
  );
}

function prettyJson(text: string): string {
  try {
    return JSON.stringify(JSON.parse(text), null, 2);
  } catch {
    return text;
  }
}

export function JobCard({ job, take }: { job: Job; take: Take | undefined }) {
  const [, tick] = useState(0);
  useEffect(() => {
    const t = window.setInterval(() => tick((n) => n + 1), 1000);
    return () => window.clearInterval(t);
  }, []);
  const since = job.startedAt ?? job.createdAt;
  const elapsed = Math.max(0, Math.round((Date.now() - since) / 1000));
  const what = job.kind === "generate" ? "Generating" : "Repainting";
  const range = take?.params.repaint ? ` ${take.params.repaint.startSec.toFixed(1)}–${take.params.repaint.endSec.toFixed(1)} s` : "";
  const pct = Math.round(job.progress * 100);
  return (
    <div className="job" data-testid="job-card" data-status={job.status}>
      <div className="job-head">
        <LoaderCircle {...icon} className="spin" />
        <span>
          {what}
          {range}, take {take?.seq ?? "…"}
        </span>
        <span className="job-time">{job.status === "queued" ? "queued" : `${elapsed} s`}</span>
      </div>
      <div className="progress" role="progressbar" aria-valuemin={0} aria-valuemax={100} aria-valuenow={pct}>
        <div className="progress-bar" style={{ transform: `scaleX(${Math.max(0.03, job.progress)})` }} />
      </div>
      <div className="job-stage">{job.status === "queued" ? "Waiting for the previous job" : `${job.stage ?? "Working"} · usually about a minute`}</div>
    </div>
  );
}

const SUGGESTIONS = [
  "Write a 30 second folk song about paper boats in the rain",
  "A 60 second upbeat synth-pop song about leaving town at sunrise, 120 bpm",
  "A slow 45 second piano ballad about an empty train station",
];

interface Props {
  messages: ChatMessage[];
  draft: string;
  busy: boolean;
  jobs: Job[];
  takes: Take[];
  selection: Selection | null;
  onClearSelection: () => void;
  onSend: (text: string) => Promise<void>;
  hasTake: boolean;
  llm: Health["llm"] | null;
}

export function Chat({ messages, draft, busy, jobs, takes, selection, onClearSelection, onSend, hasTake, llm }: Props) {
  const [text, setText] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [sending, setSending] = useState(false);
  const scroller = useRef<HTMLDivElement>(null);
  const input = useRef<HTMLTextAreaElement>(null);
  const stick = useRef(true);

  // Cmd/Ctrl+L puts the cursor in the chat box, from anywhere.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && !e.shiftKey && !e.altKey && e.key.toLowerCase() === "l") {
        e.preventDefault();
        input.current?.focus();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  useLayoutEffect(() => {
    const el = scroller.current;
    if (el && stick.current) el.scrollTop = el.scrollHeight;
  }, [messages, draft, jobs, busy]);

  // The panel itself can shrink (a banner appears, the selection chip is added above the input):
  // stay pinned to the newest message then too.
  useEffect(() => {
    const el = scroller.current;
    if (!el || typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(() => {
      if (stick.current) el.scrollTop = el.scrollHeight;
    });
    observer.observe(el);
    return () => observer.disconnect();
  }, []);

  const results = new Map<string, ToolResult>();
  for (const m of messages) if (m.role === "tool") for (const r of m.results) results.set(r.toolUseId, r);

  const submit = async (value: string) => {
    const t = value.trim();
    if (!t || busy || sending) return;
    setSending(true);
    setError(null);
    stick.current = true;
    try {
      await onSend(t);
      setText("");
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setSending(false);
    }
  };

  return (
    <section className="chat" aria-label="Agent">
      <div
        className="chat-scroll"
        ref={scroller}
        onScroll={(e) => {
          const el = e.currentTarget;
          stick.current = el.scrollHeight - el.scrollTop - el.clientHeight < 60;
        }}
      >
        {messages.length === 0 && !busy && (
          <div className="chat-empty">
            <h2>What should we write?</h2>
            <p>Say what the song is about, how it should sound and how long it is. The agent writes the lyrics and has it generated</p>
            <div className="suggestions">
              {SUGGESTIONS.map((s) => (
                <button key={s} className="suggestion" onClick={() => void submit(s)} disabled={busy || sending}>
                  <CornerDownRight {...icon} />
                  {s}
                </button>
              ))}
            </div>
          </div>
        )}

        {messages.map((m) => {
          if (m.role === "user") {
            return (
              <div key={m.id} className="msg msg-user" data-testid="msg-user">
                <div className="bubble">{m.text}</div>
                {m.selection && <div className="msg-meta">with selection {fmtRange(m.selection)}</div>}
              </div>
            );
          }
          if (m.role === "assistant") {
            return (
              <div key={m.id} className="msg msg-assistant" data-testid="msg-assistant">
                {m.blocks.map((b, i) =>
                  b.type === "text" ? (
                    <div key={i} className="assistant-text">
                      {b.text}
                    </div>
                  ) : (
                    <ToolRow key={b.id} use={b as ToolUse} result={results.get(b.id)} running={busy} />
                  ),
                )}
              </div>
            );
          }
          if (m.role === "event") {
            return (
              <div key={m.id} className={`note note-${m.kind}`} data-testid="note" data-kind={m.kind}>
                {m.kind === "take_ready" ? <Check {...icon} /> : m.kind === "info" ? <Info {...icon} /> : <CircleX {...icon} />}
                <span>{m.text}</span>
              </div>
            );
          }
          return null; // tool results are shown inside the tool rows
        })}

        {busy && (
          <div className="msg msg-assistant" data-testid="draft">
            {draft ? (
              <div className="assistant-text">
                {draft}
                <span className="caret" />
              </div>
            ) : (
              <div className="thinking">
                <LoaderCircle {...icon} className="spin" />
                Thinking
              </div>
            )}
          </div>
        )}

        {jobs.map((j) => (
          <JobCard key={j.id} job={j} take={takes.find((t) => t.id === j.takeId)} />
        ))}
      </div>

      <form
        className="composer"
        onSubmit={(e) => {
          e.preventDefault();
          void submit(text);
        }}
      >
        {error && <div className="inline-error">{error}</div>}
        <div className="composer-box">
          {selection && (
            <div className="composer-attach">
              <span className="chip chip-selection" data-testid="attached-selection" title="This selection goes with the message">
                Selection {fmtRange(selection)}
                <button type="button" className="chip-x" onClick={onClearSelection} aria-label="Remove selection">
                  <X size={12} strokeWidth={1.5} />
                </button>
              </span>
            </div>
          )}
          <textarea
            ref={input}
            value={text}
            onChange={(e) => setText(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
                e.preventDefault();
                void submit(text);
              }
            }}
            placeholder={hasTake ? (selection ? "What should change in the selected part" : "Ask for a change, or select a part of the waveform first") : "Describe the song you want"}
            rows={2}
            aria-label="Message the agent"
            data-testid="chat-input"
          />
          <div className="composer-foot">
            {llm && <span className="composer-model">{llmLabel(llm)}</span>}
            <span className="kbd" title="Focus the chat box">
              {/Mac|iPhone|iPad/.test(navigator.platform) ? "⌘L" : "Ctrl L"}
            </span>
            <button className="send" type="submit" disabled={busy || sending || !text.trim()} aria-label="Send" title="Send" data-testid="chat-send">
              {busy ? <LoaderCircle {...icon} className="spin" /> : <ArrowUp size={14} strokeWidth={2} />}
            </button>
          </div>
        </div>
      </form>
    </section>
  );
}
