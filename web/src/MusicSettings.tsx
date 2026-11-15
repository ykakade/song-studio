import { useState } from "react";
import { ChevronRight, Plus, X } from "lucide-react";
import { api, type ChordRegion, type Selection, type Timeline } from "./api.ts";

export function MusicSettings({
  projectId,
  timeline,
  selection,
  onError,
}: {
  projectId: string;
  timeline: Timeline;
  selection: Selection | null;
  onError: (s: string | null) => void;
}) {
  const [bpm, setBpm] = useState(String(timeline.grid.bpm));
  const [downbeat, setDownbeat] = useState(String(timeline.grid.firstBeatSec));
  const [chords, setChords] = useState<ChordRegion[]>(timeline.chords);
  const [busy, setBusy] = useState(false);
  const dirty =
    Number(bpm) !== timeline.grid.bpm ||
    Number(downbeat) !== timeline.grid.firstBeatSec ||
    JSON.stringify(chords) !== JSON.stringify(timeline.chords);
  const patch = (i: number, change: Partial<ChordRegion>) => setChords((rows) => rows.map((c, n) => (n === i ? { ...c, ...change } : c)));
  return (
    <details className="music-settings">
      <summary>
        <ChevronRight size={14} strokeWidth={1.5} />
        Tempo & chords<span className="muted">{timeline.chords.length ? `${timeline.chords.length} regions` : "Home chord"}</span>
      </summary>
      <form
        className="music-form"
        onSubmit={async (e) => {
          e.preventDefault();
          setBusy(true);
          onError(null);
          try {
            await api.setMusic(projectId, { bpm: Number(bpm), firstBeatSec: Number(downbeat), chords });
          } catch (err) {
            onError((err as Error).message);
          } finally {
            setBusy(false);
          }
        }}
      >
        <div className="music-fields">
          <label>
            Tempo{" "}
            <span>
              <input
                aria-label="Tempo in BPM"
                type="number"
                min="40"
                max="220"
                step="any"
                required
                value={bpm}
                onChange={(e) => setBpm(e.target.value)}
              />{" "}
              bpm
            </span>
          </label>
          <label>
            First downbeat{" "}
            <span>
              <input
                aria-label="First downbeat in seconds"
                type="number"
                min="0"
                max={timeline.durationSec - 0.01}
                step="any"
                required
                value={downbeat}
                onChange={(e) => setDownbeat(e.target.value)}
              />{" "}
              s
            </span>
          </label>
          <span className="muted small">Applies to added instruments. The recording keeps its tempo.</span>
        </div>
        <div className="chord-table">
          {chords.length > 0 && (
            <div className="chord-row chord-heading">
              <span>Chord</span>
              <span>From · s</span>
              <span>To · s</span>
              <span />
            </div>
          )}
          {chords.map((c, i) => (
            <div className="chord-row" key={i}>
              <input
                aria-label={`Chord ${i + 1}`}
                value={c.chord}
                placeholder="Am"
                required
                onChange={(e) => patch(i, { chord: e.target.value })}
              />
              <input
                aria-label={`Chord ${i + 1} start`}
                type="number"
                min="0"
                step="any"
                required
                value={c.startSec}
                onChange={(e) => patch(i, { startSec: Number(e.target.value) })}
              />
              <input
                aria-label={`Chord ${i + 1} end`}
                type="number"
                min="0"
                max={timeline.durationSec}
                step="any"
                required
                value={c.endSec}
                onChange={(e) => patch(i, { endSec: Number(e.target.value) })}
              />
              <button
                type="button"
                className="icon-btn"
                aria-label={`Remove chord ${i + 1}`}
                onClick={() => setChords((rows) => rows.filter((_, n) => n !== i))}
              >
                <X size={14} />
              </button>
            </div>
          ))}
        </div>
        <div className="setting-actions">
          <button
            type="button"
            className="btn btn-small"
            disabled={chords.length >= 64}
            onClick={() => {
              const startSec = selection?.startSec ?? chords.at(-1)?.endSec ?? 0;
              setChords((rows) => [
                ...rows,
                {
                  chord: "C",
                  startSec: Math.round(startSec * 1000) / 1000,
                  endSec:
                    Math.round((selection?.endSec ?? Math.min(timeline.durationSec, startSec + 4 * timeline.grid.beatSec)) * 1000) / 1000,
                },
              ]);
            }}
          >
            <Plus size={12} />
            {selection ? "Chord at selection" : "Add chord region"}
          </button>
          <span className="spacer" />
          <button className="btn btn-small" disabled={!dirty || busy}>
            {busy ? "Applying…" : "Apply"}
          </button>
        </div>
        <p className="muted small">Major and minor chords: C, Am, F#, Bb. Gaps use the song’s key. Imported recordings stay as recorded.</p>
      </form>
    </details>
  );
}
