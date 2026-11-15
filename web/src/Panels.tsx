import { AudioLines, Bookmark, Check, ChevronRight, CircleX, CornerDownRight, FileText, LoaderCircle, TriangleAlert, X } from "lucide-react";
import type { DetectedSection, Marker, Selection, SpliceChecks, Take, TakeTiming } from "./api.ts";
import { timeAgo } from "./api.ts";

const icon = { size: 14, strokeWidth: 1.5 } as const;
const range = (r: { startSec: number; endSec: number }) => `${r.startSec.toFixed(1)}–${r.endSec.toFixed(1)} s`;

// --- lyrics -----------------------------------------------------------------------

export function Lyrics({
  take,
  parent,
  timing,
  onSelectLine,
}: {
  take: Take;
  parent: Take | null;
  /** Where the lines were heard in this take, if known. */
  timing: TakeTiming | null;
  onSelectLine: (range: Selection) => void;
}) {
  const before = new Set((parent?.params.lyrics ?? "").split("\n").map((l) => l.trim()));
  const lines = take.params.lyrics.split("\n");
  // Timed lines come in lyric order; hand them out to sung lines in the same order.
  const timed = [...(timing?.lines ?? [])];
  const p = take.params;
  return (
    <section className="doc" aria-label="Lyrics">
      <header className="doc-tabs">
        <span className="doc-tab">
          <FileText {...icon} />
          lyrics.md
        </span>
        <span className="mono">
          {p.bpm} bpm · {p.key} · {p.timeSignature}/4
        </span>
      </header>
      <div className="lyrics-body" data-testid="lyrics">
        {lines.map((line, i) => {
          const t = line.trim();
          if (!t) return <div key={i} className="lyric-gap" />;
          const changed = parent !== null && !before.has(t);
          if (/^\[.*\]$/.test(t)) {
            return (
              <div key={i} className={`lyric-tag ${changed ? "lyric-changed" : ""}`}>
                <span>{t.slice(1, -1)}</span>
              </div>
            );
          }
          const at = /[\p{L}\p{N}]/u.test(t.replace(/\[[^\]]*\]/g, "")) ? timed.shift() : undefined;
          const placed = at && at.startSec !== null && at.endSec !== null;
          return (
            <div key={i} className={`lyric-line ${changed ? "lyric-changed" : ""} ${timing && !placed ? "lyric-unheard" : ""}`}>
              {placed ? (
                <button
                  className="lyric-time"
                  onClick={() => onSelectLine({ startSec: at!.startSec!, endSec: at!.endSec! })}
                  title={`Heard ${at!.wordsHeard} of ${at!.words} words here. Click to select this line.`}
                >
                  {at!.startSec!.toFixed(1)}
                </button>
              ) : timing ? (
                <span className="lyric-time" title="Speech recognition did not hear this line">
                  –
                </span>
              ) : null}
              <span>{line}</span>
            </div>
          );
        })}
      </div>
      <footer className="style-prompt">
        <span className="tool-label">style</span>
        <span>{p.stylePrompt}</span>
      </footer>
    </section>
  );
}

// --- splice check ---------------------------------------------------------------------

const db = (v: number | null | undefined, digits = 2) => (v === null || v === undefined ? "n/a" : `${v >= 0 ? "+" : ""}${v.toFixed(digits)} dB`);

export function CheckBadge({ checks, compact = false }: { checks: SpliceChecks; compact?: boolean }) {
  const kind =
    checks.status === "verified"
      ? { cls: "badge-ok", label: "Rest untouched", title: "Every sample outside the repainted range is bit-identical to the parent take", Icon: Check }
      : checks.status === "fallback"
        ? { cls: "badge-warn", label: "Not verified", title: checks.reason ?? "", Icon: TriangleAlert }
        : { cls: "badge-error", label: "Check failed", title: checks.reason ?? "", Icon: CircleX };
  return (
    <span
      className={`badge ${kind.cls} ${compact ? "badge-compact" : ""}`}
      data-testid="check-badge"
      data-status={checks.status}
      title={compact ? `${kind.label}. ${kind.title}` : kind.title}
      aria-label={compact ? kind.label : undefined}
    >
      <kind.Icon {...icon} />
      {!compact && kind.label}
    </span>
  );
}

function CheckDetails({ checks }: { checks: SpliceChecks }) {
  return (
    <div className="check-details" data-testid="check-details">
      {checks.status !== "verified" && <p className="check-reason">{checks.reason}</p>}
      {checks.status === "verified" && checks.reason && <p className="muted">{checks.reason}</p>}
      <dl>
        <dt>Outside the range</dt>
        <dd>
          {checks.status === "verified"
            ? `${checks.outsideSamples.toLocaleString()} samples compared with the parent, ${checks.outsideMismatches} differ`
            : "not guaranteed identical to the parent"}
        </dd>
        <dt>Model's gain change</dt>
        <dd>
          {checks.gainDb === null ? "could not be estimated" : `${db(checks.gainDb, 3)} on the whole file`}
          {checks.status === "verified" && checks.gainDb !== null && <>, undone inside the range{checks.gainLimitedToAvoidClipping ? " (limited to avoid clipping)" : ""}</>}
        </dd>
        <dt>Match with parent</dt>
        <dd>
          {checks.correlation === null ? "n/a" : `correlation ${checks.correlation.toFixed(8)}`}
          {checks.residualLsb !== null && `, largest leftover ${checks.residualLsb} of 32768 steps`}
        </dd>
        <dt>Crossfade</dt>
        <dd>{checks.status === "verified" ? `${checks.crossfadeMs} ms equal-power, inside the range` : "the model's own"}</dd>
      </dl>
      {checks.boundaries.length > 0 && (
        <table className="boundaries">
          <thead>
            <tr>
              <th>Join</th>
              <th title="Level of the new audio minus level of the kept audio, 100 ms either side of the join">Level step</th>
              <th title="The same level step measured on the parent take at this spot">Parent</th>
              <th title="Quietest 5 ms within 50 ms of the join, relative to the quieter side. Music dips between beats anyway, so compare with the parent.">Dip</th>
              <th title="The same dip measured on the parent take at this spot">Parent</th>
            </tr>
          </thead>
          <tbody>
            {checks.boundaries.map((b) => (
              <tr key={b.edge}>
                <td>
                  {b.edge} · {b.timeSec.toFixed(2)} s
                </td>
                <td>{db(b.stepDb, 1)}</td>
                <td>{db(b.parentStepDb, 1)}</td>
                <td>{db(b.dipDb, 1)}</td>
                <td>{db(b.parentDipDb, 1)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}

/** The bottom panel: everything the app measured about one take. */
export function TakeDetails({ take, onClose }: { take: Take; onClose: () => void }) {
  return (
    <section className="bottom-panel" aria-label={`Take ${take.seq} details`}>
      <header className="bottom-head">
        <span>
          Take {take.seq} · {take.checks ? "splice check" : "details"}
        </span>
        <button className="icon-btn" onClick={onClose} aria-label="Close details" title="Close">
          <X {...icon} />
        </button>
      </header>
      <div className="bottom-body">
        {take.status === "failed" && <p className="check-reason">{take.error}</p>}
        {take.checks && <CheckDetails checks={take.checks} />}
        <p className="take-meta">
          {take.id} · seed {take.params.seed} · {take.durationSec ? `${take.durationSec.toFixed(1)} s · ` : ""}
          {timeAgo(take.createdAt)}
        </p>
      </div>
    </section>
  );
}

// --- take history -----------------------------------------------------------------------

interface Row {
  take: Take;
  depth: number;
}

/** Parent chain as an indented list: each root, then its descendants depth-first. */
function rows(takes: Take[]): Row[] {
  const children = new Map<string | null, Take[]>();
  for (const t of takes) {
    const key = t.parentTakeId && takes.some((x) => x.id === t.parentTakeId) ? t.parentTakeId : null;
    children.set(key, [...(children.get(key) ?? []), t]);
  }
  const out: Row[] = [];
  const walk = (parent: string | null, depth: number) => {
    for (const t of children.get(parent) ?? []) {
      out.push({ take: t, depth });
      walk(t.id, depth + 1);
    }
  };
  walk(null, 0);
  return out;
}

interface HistoryProps {
  takes: Take[];
  currentTakeId: string | null;
  onSelect: (takeId: string) => void;
  /** The take whose details are open in the bottom panel. */
  detailsId: string | null;
  onDetails: (takeId: string | null) => void;
}

export function TakeHistory({ takes, currentTakeId, onSelect, detailsId, onDetails }: HistoryProps) {
  return (
    <section className="side-section" aria-label="Take history">
      <header className="side-head" title="Every change is a new take. Nothing is overwritten.">
        <h3>Takes</h3>
        <span className="mono">{takes.length}</span>
      </header>
      {takes.length === 0 && <p className="side-empty">Every change becomes a new take here. Nothing is overwritten</p>}
      <ol className="take-list" data-testid="take-list">
        {rows(takes).map(({ take: t, depth }) => {
          const current = t.id === currentTakeId;
          const selectable = t.status === "done";
          const parent = takes.find((x) => x.id === t.parentTakeId);
          const r = t.params.repaint;
          const open = detailsId === t.id;
          return (
            <li key={t.id} className={`take ${current ? "take-current" : ""} take-${t.status}`} data-testid="take" data-take-id={t.id} data-seq={t.seq} data-current={current}>
              <button
                className="take-select"
                style={{ paddingLeft: 8 + Math.min(depth, 5) * 12 }}
                disabled={!selectable}
                onClick={() => onSelect(t.id)}
                title={selectable ? "Load this take" : undefined}
              >
                <span className="take-line">
                  {depth > 0 && <CornerDownRight size={12} strokeWidth={1.5} />}
                  <span className="take-num">Take {t.seq}</span>
                  <span className="take-what">
                    {t.kind === "generate" ? "New song" : `Repaint ${r ? range(r) : ""}`}
                    {parent && <> of take {parent.seq}</>}
                  </span>
                </span>
                <span className="take-summary">{t.changeSummary}</span>
              </button>
              <div className="take-side">
                {(t.status === "queued" || t.status === "running") && (
                  <span title={t.status === "queued" ? "Queued" : "In progress"} style={{ display: "inline-flex" }}>
                    <LoaderCircle {...icon} className="spin" aria-label={t.status === "queued" ? "Queued" : "In progress"} />
                  </span>
                )}
                {t.status === "failed" && (
                  <span title={t.error ?? "Failed"} style={{ display: "inline-flex", color: "var(--bad)" }}>
                    <CircleX {...icon} aria-label="Failed" />
                  </span>
                )}
                {t.checks && <CheckBadge checks={t.checks} compact />}
                {(t.checks || t.status === "failed" || t.status === "done") && (
                  <button className="icon-btn" onClick={() => onDetails(open ? null : t.id)} aria-expanded={open} aria-pressed={open} aria-label="Details" title="Details" data-testid="take-details-toggle">
                    <ChevronRight {...icon} />
                  </button>
                )}
              </div>
            </li>
          );
        })}
      </ol>
    </section>
  );
}

// --- sections: the song's outline ---------------------------------------------------------

interface OutlineProps {
  markers: Marker[];
  heard: DetectedSection[];
  timing: TakeTiming | null;
  analysing: boolean;
  onSelect: (range: Selection) => void;
  onDeleteMarker: (label: string) => void;
  onAnalyse: () => void;
}

export function Outline({ markers, heard, timing, analysing, onSelect, onDeleteMarker, onAnalyse }: OutlineProps) {
  return (
    <section className="side-section" aria-label="Sections">
      <header className="side-head">
        <h3>Sections</h3>
        {timing && (
          <span className="heard-stat" title={`Speech recognition: ${timing.model}`} data-testid="words-heard">
            {timing.lyricWordsHeard}/{timing.lyricWords} words heard
          </span>
        )}
      </header>
      <ul className="outline">
        {markers.map((m) => (
          <li key={`m-${m.label}`} className="outline-row" data-testid="marker">
            <button className="outline-main" onClick={() => onSelect({ startSec: m.startSec, endSec: m.endSec })} title="A section you named. Click to select it">
              <Bookmark {...icon} />
              <span className="outline-label">{m.label}</span>
              <span className="outline-range">{range(m)}</span>
            </button>
            <button className="icon-btn" aria-label={`Delete marker ${m.label}`} title="Delete" onClick={() => onDeleteMarker(m.label)}>
              <X size={12} strokeWidth={1.5} />
            </button>
          </li>
        ))}
        {heard.map((h) => (
          <li key={`h-${h.label}`} className="outline-row" data-testid="heard-section">
            <button className="outline-main" onClick={() => onSelect({ startSec: h.startSec, endSec: h.endSec })} title="Heard in this take. Click to select it">
              <AudioLines {...icon} />
              <span className="outline-label">{h.label}</span>
              <span className="outline-range">{range(h)}</span>
            </button>
          </li>
        ))}
      </ul>
      {markers.length === 0 && heard.length === 0 && (
        <p className="side-empty">
          {analysing && !timing ? "Listening for the words" : timing ? "No lyrics recognised in this take. Select a part of the waveform and name it" : "Nothing placed yet"}
        </p>
      )}
      {!analysing && !timing && (
        <div className="side-foot">
          <button className="btn btn-small" onClick={onAnalyse}>
            <AudioLines size={12} strokeWidth={1.5} />
            Find the words
          </button>
        </div>
      )}
    </section>
  );
}
