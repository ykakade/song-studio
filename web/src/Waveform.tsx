import { Pause, Play, X } from "lucide-react";
import { useEffect, useRef, useState, type ReactNode } from "react";
import WaveSurfer from "wavesurfer.js";
import RegionsPlugin, { type Region } from "wavesurfer.js/plugins/regions";
import { api, fmtTime, type DetectedSection, type Marker, type Selection } from "./api.ts";

const SELECTION_ID = "sel";
const CHANGED_ID = "chg";
const MARKER_PREFIX = "m-";
const HEARD_PREFIX = "h-";
const HEARD_COLOR = "rgba(237, 237, 237, 0.03)";
const SELECTION_COLOR = "rgba(233, 168, 76, 0.22)";
const MARKER_COLOR = "rgba(237, 237, 237, 0.06)";
const CHANGED_COLOR = "rgba(76, 195, 138, 0.14)";
const LABEL_MUTED = "#85858b";
const LABEL_TEXT = "#a1a1a6";
const LABEL_OK = "#4cc38a";
/** Shortest range the app will repaint; the selection snaps up to this. */
const MIN_SELECTION_SEC = 0.5;

interface Props {
  /** The take whose audio is drawn and played. */
  takeId: string;
  /** Takes of the same song share this key; the playhead is kept when switching between them. */
  songKey: string;
  selection: Selection | null;
  onSelection: (selection: Selection | null) => void;
  markers: Marker[];
  /** The range this take regenerated (shown as a quiet green band). */
  changedRange: Selection | null;
  /** Sections the app heard in this take (speech recognition), labelled along the bottom edge. */
  heard: DetectedSection[];
  /** Extra controls shown next to the selection readout. */
  selectionActions?: ReactNode;
}

function label(text: string, color: string, bottom = false): HTMLElement {
  const el = document.createElement("span");
  el.textContent = text;
  el.style.cssText = `position:absolute;${bottom ? "bottom:2px" : "top:2px"};left:6px;font:400 10px/16px "Geist Mono Variable",ui-monospace,monospace;color:${color};white-space:nowrap;pointer-events:none`;
  return el;
}

const round = (v: number) => Math.round(v * 100) / 100;
const same = (a: Selection | null, b: Selection | null) =>
  a === b || (!!a && !!b && Math.abs(a.startSec - b.startSec) < 0.005 && Math.abs(a.endSec - b.endSec) < 0.005);

export function Waveform({ takeId, songKey, selection, onSelection, markers, changedRange, heard, selectionActions }: Props) {
  const containerRef = useRef<HTMLDivElement>(null);
  const wsRef = useRef<WaveSurfer | null>(null);
  const regionsRef = useRef<ReturnType<typeof RegionsPlugin.create> | null>(null);
  const onSelectionRef = useRef(onSelection);
  onSelectionRef.current = onSelection;
  const selectionRef = useRef(selection);
  selectionRef.current = selection;
  const selRegionRef = useRef<Region | null>(null);
  const lastSongKey = useRef<string | null>(null);

  const [ready, setReady] = useState(false);
  const [playing, setPlaying] = useState(false);
  const [time, setTime] = useState(0);
  const [duration, setDuration] = useState(0);
  const [error, setError] = useState<string | null>(null);

  // Create the player once.
  useEffect(() => {
    const regions = RegionsPlugin.create();
    const ws = WaveSurfer.create({
      container: containerRef.current!,
      height: 120,
      waveColor: "#505055",
      progressColor: "#dcdcdc",
      cursorColor: "#e9a84c",
      cursorWidth: 1,
      barWidth: 2,
      barGap: 1,
      barRadius: 1,
      normalize: false,
      dragToSeek: false,
      plugins: [regions],
    });
    wsRef.current = ws;
    regionsRef.current = regions;

    const report = (r: Region) => {
      if (r.id !== SELECTION_ID) return;
      const next = { startSec: round(r.start), endSec: round(r.end) };
      if (!same(next, selectionRef.current)) onSelectionRef.current(next);
    };
    // A new drag starts: the previous selection goes away. Live-update the readout while dragging.
    // (While a region is being dragged out it is not yet in regions.getRegions(), hence our own ref.)
    regions.on("region-initialized", (r) => {
      if (r.id !== SELECTION_ID) return;
      if (selRegionRef.current && selRegionRef.current !== r) selRegionRef.current.remove();
      selRegionRef.current = r;
      r.on("update", () => report(r));
    });
    regions.on("region-created", report);
    regions.on("region-updated", report);
    regions.enableDragSelection({ id: SELECTION_ID, color: SELECTION_COLOR, minLength: MIN_SELECTION_SEC });

    ws.on("play", () => setPlaying(true));
    ws.on("pause", () => setPlaying(false));
    ws.on("finish", () => setPlaying(false));
    ws.on("timeupdate", (t) => setTime(t));
    ws.on("ready", (d) => setDuration(d));
    ws.on("error", (e) => setError(e.message));

    return () => {
      ws.destroy();
      wsRef.current = null;
      regionsRef.current = null;
      selRegionRef.current = null;
    };
  }, []);

  // Load a take. Peaks come precomputed from the server, so nothing is decoded in the browser.
  useEffect(() => {
    const ws = wsRef.current;
    if (!ws) return;
    let cancelled = false;
    const keep = lastSongKey.current === songKey;
    const resumeAt = keep ? ws.getCurrentTime() : 0;
    const wasPlaying = keep && ws.isPlaying();
    lastSongKey.current = songKey;
    setReady(false);
    setError(null);
    (async () => {
      try {
        const { peaks, durationSec } = await api.peaks(takeId);
        if (cancelled) return;
        await ws.load(api.audioUrl(takeId), [peaks], durationSec);
        if (cancelled) return;
        if (resumeAt > 0 && resumeAt < durationSec) ws.setTime(resumeAt);
        else setTime(0);
        setReady(true);
        if (wasPlaying) void ws.play();
      } catch (e) {
        if (!cancelled) setError((e as Error).message);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [takeId, songKey]);

  // Keep the selection region in step with the selection state (cleared, or set from a marker chip).
  useEffect(() => {
    const regions = regionsRef.current;
    if (!regions || !ready) return;
    const current = selRegionRef.current;
    if (!selection) {
      current?.remove();
      selRegionRef.current = null;
      return;
    }
    if (current && !current.isRemoved) {
      if (!same({ startSec: round(current.start), endSec: round(current.end) }, selection)) {
        current.setOptions({ start: selection.startSec, end: selection.endSec });
      }
    } else {
      regions.addRegion({ id: SELECTION_ID, start: selection.startSec, end: selection.endSec, color: SELECTION_COLOR, minLength: MIN_SELECTION_SEC });
    }
  }, [selection, ready]);

  // Section markers and the "this take changed here" band: display only, they never catch the mouse.
  useEffect(() => {
    const regions = regionsRef.current;
    if (!regions || !ready) return;
    for (const r of regions.getRegions()) if (r.id.startsWith(MARKER_PREFIX) || r.id.startsWith(HEARD_PREFIX) || r.id === CHANGED_ID) r.remove();
    const passive = (r: Region) => {
      if (!r.element) return;
      r.element.style.pointerEvents = "none";
      r.element.style.boxShadow = "inset 1px 0 0 rgba(237, 237, 237, 0.12)";
    };
    if (changedRange) {
      passive(
        regions.addRegion({
          id: CHANGED_ID,
          start: changedRange.startSec,
          end: changedRange.endSec,
          color: CHANGED_COLOR,
          drag: false,
          resize: false,
          content: label("changed in this take", LABEL_OK),
        }),
      );
    }
    heard.forEach((h, i) =>
      passive(
        regions.addRegion({
          id: `${HEARD_PREFIX}${i}`,
          start: h.startSec,
          end: h.endSec,
          color: HEARD_COLOR,
          drag: false,
          resize: false,
          content: label(h.label, LABEL_MUTED, true),
        }),
      ),
    );
    markers.forEach((m, i) =>
      passive(
        regions.addRegion({
          id: `${MARKER_PREFIX}${i}`,
          start: m.startSec,
          end: m.endSec,
          color: MARKER_COLOR,
          drag: false,
          resize: false,
          content: label(m.label, LABEL_TEXT),
        }),
      ),
    );
  }, [markers, changedRange, heard, ready]);

  // Space toggles playback unless the user is typing.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement | null;
      if (e.code === "Escape" && selectionRef.current && !(t && (t.tagName === "TEXTAREA" || t.tagName === "INPUT"))) {
        onSelectionRef.current(null);
        return;
      }
      if (e.code !== "Space" || e.metaKey || e.ctrlKey || e.altKey) return;
      if (t && (t.tagName === "TEXTAREA" || t.tagName === "INPUT" || t.tagName === "BUTTON" || t.isContentEditable)) return;
      e.preventDefault();
      void wsRef.current?.playPause();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  return (
    <div className="waveform">
      <div className={`wave-canvas ${ready ? "" : "wave-loading"}`} ref={containerRef} data-testid="waveform" />
      {error && <div className="inline-error">Could not load the audio: {error}</div>}
      <div className="transport">
        <button
          className="btn btn-round"
          onClick={() => void wsRef.current?.playPause()}
          disabled={!ready}
          aria-label={playing ? "Pause" : "Play"}
          data-testid="play"
          data-playing={playing}
        >
          {playing ? <Pause size={14} strokeWidth={0} fill="currentColor" aria-hidden="true" /> : <Play size={14} strokeWidth={0} fill="currentColor" aria-hidden="true" style={{ marginLeft: 2 }} />}
        </button>
        <span className="time" data-testid="time" data-seconds={time.toFixed(2)}>
          {fmtTime(time)} <span className="muted">/ {fmtTime(duration)}</span>
        </span>
        <div className="selection-readout">
          {selection ? (
            <>
              <span className="chip chip-selection" data-testid="selection">
                Selected {selection.startSec.toFixed(2)}–{selection.endSec.toFixed(2)} s
                <button className="chip-x" onClick={() => onSelection(null)} aria-label="Clear selection" title="Clear selection">
                  <X size={12} strokeWidth={1.5} />
                </button>
              </span>
              <button className="btn btn-small" disabled={!ready} onClick={() => void wsRef.current?.play(selection.startSec, selection.endSec)}>
                Play selection
              </button>
              {selectionActions}
            </>
          ) : (
            <span className="muted small">Drag across the waveform to select the part to change</span>
          )}
        </div>
      </div>
    </div>
  );
}
