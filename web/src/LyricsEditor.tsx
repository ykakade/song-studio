import { useEffect, useRef, useState } from "react";
import { FileText } from "lucide-react";
import { api, type Selection, type Take, type TakeTiming } from "./api.ts";
import { countSungWords, wordBudget } from "../../server/lyrics.ts";
import { Lyrics } from "./Panels.tsx";

export function LyricsEditor({
  projectId,
  take,
  parent,
  timing,
  draft,
  selection,
  readOnly,
  onSelectLine,
  onError,
}: {
  projectId: string;
  take: Take;
  parent: Take | null;
  timing: TakeTiming | null;
  draft: string | null;
  selection: Selection | null;
  readOnly: boolean;
  onSelectLine: (s: Selection) => void;
  onError: (s: string | null) => void;
}) {
  const bufferKey = `song-studio.lyrics.${projectId}.${take.id}`;
  const [buffer] = useState(() => {
    try {
      return localStorage.getItem(bufferKey);
    } catch {
      return null;
    }
  });
  const [editing, setEditing] = useState(!readOnly && (!!draft || buffer !== null));
  const [text, setText] = useState(buffer ?? draft ?? take.params.lyrics);
  const [saved, setSaved] = useState(draft ?? take.params.lyrics);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState("");
  const currentText = useRef(text);
  currentText.current = text;
  useEffect(() => {
    // External updates must not replace an unsaved editor buffer.
    if (text !== saved) return;
    const next = draft ?? take.params.lyrics;
    setText(next);
    setSaved(next);
  }, [draft, take.params.lyrics]);
  const words = countSungWords(text);
  const budget = Math.max(
    wordBudget(take.durationSec ?? take.params.durationSec, take.params.bpm, take.params.timeSignature),
    countSungWords(take.params.lyrics),
  );
  const save = async () => {
    const value = currentText.current;
    setBusy(true);
    onError(null);
    try {
      await api.saveLyrics(projectId, value);
      setSaved(value);
      try {
        localStorage.removeItem(bufferKey);
      } catch {}
      setNotice("Draft saved");
    } catch (err) {
      onError((err as Error).message);
    } finally {
      setBusy(false);
    }
  };
  useEffect(() => {
    if (!editing) return;
    const key = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key === "s") {
        e.preventDefault();
        void save();
      }
    };
    window.addEventListener("keydown", key);
    const leave = (e: BeforeUnloadEvent) => {
      if (currentText.current !== saved) {
        e.preventDefault();
        e.returnValue = "";
      }
    };
    window.addEventListener("beforeunload", leave);
    return () => {
      window.removeEventListener("keydown", key);
      window.removeEventListener("beforeunload", leave);
    };
  }, [editing, projectId, saved]);
  if (!editing)
    return (
      <div className="lyrics-document">
        <Lyrics
          take={take}
          parent={parent}
          timing={timing}
          onSelectLine={onSelectLine}
          actions={
            !readOnly && (
              <button className="btn btn-small" onClick={() => setEditing(true)}>
                Edit lyrics
              </button>
            )
          }
        />
      </div>
    );
  const original = take.params.lyrics.split("\n");
  return (
    <section className="doc lyric-editor" aria-label="Lyric draft">
      <header className="doc-tabs">
        <span className="doc-tab">
          <FileText size={14} strokeWidth={1.5} />
          lyrics.md
          <span className="draft-dot" title={text !== saved ? "Unsaved changes" : "Draft differs from recording"} />
        </span>
        <span className="muted small">Working copy</span>
        <span className="spacer" />
        <button className="btn btn-small" onClick={() => setEditing(false)}>
          Recording
        </button>
      </header>
      <div className="lyric-source">
        <div className="line-numbers" aria-hidden="true">
          {text.split("\n").map((line, i) => (
            <div className={line !== original[i] ? "line-edited" : ""} key={i}>
              {i + 1}
            </div>
          ))}
        </div>
        <textarea
          aria-label="Lyrics draft"
          data-testid="lyrics-editor"
          spellCheck={false}
          readOnly={readOnly}
          maxLength={6000}
          value={text}
          rows={Math.max(10, text.split("\n").length + 1)}
          onChange={(e) => {
            setText(e.target.value);
            try {
              localStorage.setItem(bufferKey, e.target.value);
            } catch {}
            setNotice("");
          }}
        />
      </div>
      <footer className="lyric-editor-footer">
        <div className={`word-budget ${words > budget ? "over-budget" : ""}`}>
          <span>
            {words} / {budget} words
          </span>
          <meter min="0" max={Math.max(1, budget)} value={words} aria-label="Lyric word budget" />
        </div>
        <span className="muted small" role="status">
          {notice || (text !== saved ? "Unsaved" : "Saved")}
        </span>
        <span className="spacer" />
        <button
          className="btn btn-small"
          disabled={busy || text === saved || readOnly}
          onClick={() => void save()}
          title="Save draft (⌘S / Ctrl+S)"
        >
          Save draft
        </button>
        <button
          className="btn btn-small"
          disabled={busy || readOnly || !selection || words > budget || !text.trim() || text === take.params.lyrics}
          title={
            selection
              ? `Regenerate ${selection.startSec.toFixed(2)}–${selection.endSec.toFixed(2)} s with this draft`
              : "Select the section to regenerate in the waveform"
          }
          onClick={async () => {
            if (!selection) return;
            setBusy(true);
            onError(null);
            try {
              await api.saveLyrics(projectId, text);
              setSaved(text);
              try {
                localStorage.removeItem(bufferKey);
              } catch {}
              await api.repaint(projectId, { takeId: take.id, ...selection, lyrics: text });
              setNotice("Regeneration queued");
            } catch (err) {
              onError((err as Error).message);
            } finally {
              setBusy(false);
            }
          }}
        >
          Regenerate selection
        </button>
      </footer>
      {words > budget && <p className="inline-error">Remove {words - budget} words to keep the vocals within this song’s budget.</p>}
      {!selection && <p className="draft-hint muted small">Select a line or drag across the waveform to choose what to regenerate.</p>}
    </section>
  );
}
