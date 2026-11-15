import { Pause, Play, Repeat2, Headphones, X } from "lucide-react";
import { useEffect, useRef, useState, type ReactNode } from "react";
import WaveSurfer from "wavesurfer.js";
import WebAudioPlayer from "wavesurfer.js/dist/webaudio.js";
import RegionsPlugin, { type Region } from "wavesurfer.js/plugins/regions";
import { api, fmtTime, type DetectedSection, type Marker, type Selection } from "./api.ts";
import type { Player } from "./Timeline.tsx";

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
  auditionRequest?: { takeId: string; ranges: Selection[] } | null;
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
  /** The label in the gutter next to the waveform (the song is the first row of the timeline). */
  head?: ReactNode;
  /** The timeline's tracks, drawn under the waveform on the same time axis. */
  tracks?: ReactNode;
  /** Called with the player once it exists (and with null when it goes away), so the tracks can play in step. */
  onPlayer?: (player: Player | null) => void;
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

export function Waveform({ auditionRequest, takeId, songKey, selection, onSelection, markers, changedRange, heard, selectionActions, head, tracks, onPlayer }: Props) {
  const containerRef = useRef<HTMLDivElement>(null);
  const wsRef = useRef<WaveSurfer | null>(null);
  const regionsRef = useRef<ReturnType<typeof RegionsPlugin.create> | null>(null);
  const onSelectionRef = useRef(onSelection);
  onSelectionRef.current = onSelection;
  const selectionRef = useRef(selection);
  selectionRef.current = selection;
  const selRegionRef = useRef<Region | null>(null);
  const lastSongKey = useRef<string | null>(null);
  const mediaRef = useRef<WebAudioPlayer | null>(null);
  const onPlayerRef = useRef(onPlayer);
  onPlayerRef.current = onPlayer;

  const [loop, setLoop] = useState(false);
  const [preroll, setPreroll] = useState(2);
  const auditionRef = useRef<{ ranges: Selection[]; index: number } | null>(null);
  const loopRef = useRef(loop);
  loopRef.current = loop;
  const playAudition = (ranges: Selection[]) => {
    if (!ranges.length) return;
    auditionRef.current = { ranges, index: 0 };
    wsRef.current?.setTime(ranges[0].startSec);
    void wsRef.current?.play();
  };
  const [loadedTake, setLoadedTake] = useState<string | null>(null);
  const lastAudition = useRef<unknown>(null);
  const [ready, setReady] = useState(false);
  const [playing, setPlaying] = useState(false);
  const [time, setTime] = useState(0);
  const [duration, setDuration] = useState(0);
  const [error, setError] = useState<string | null>(null);

  // Create the player once. The song is played as a decoded buffer on an AudioContext rather than
  // through an <audio> element, so that the timeline's clips can be scheduled on the same clock
  // and stay in time with it to the sample.
  useEffect(() => {
    const regions = RegionsPlugin.create();
    const ctx = new AudioContext({ latencyHint: "interactive" });
    const media = new WebAudioPlayer(ctx);
    mediaRef.current = media;
    const ws = WaveSurfer.create({
      container: containerRef.current!,
      media: media as unknown as HTMLMediaElement,
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
    const advance = (finished = false) => {
      const audition = auditionRef.current;
      const selected = selectionRef.current;
      const range = audition?.ranges[audition.index] ?? (loopRef.current ? selected : null);
      if (!range || (!finished && ws.getCurrentTime() < range.endSec)) return;
      if (audition && audition.index + 1 < audition.ranges.length) {
        audition.index++;
        ws.setTime(audition.ranges[audition.index].startSec);
        if (finished) void ws.play();
      } else if (loopRef.current) {
        if (audition) audition.index = 0;
        ws.setTime(audition?.ranges[0].startSec ?? selected!.startSec);
        if (finished) void ws.play();
      } else {
        auditionRef.current = null;
        ws.pause();
      }
    };
    ws.on("finish", () => { setPlaying(false); advance(true); });
    ws.on("timeupdate", (t) => { setTime(t); advance(); });
    ws.on("ready", (d) => setDuration(d));
    ws.on("error", (e) => setError(e.message));
    onPlayerRef.current?.({ ws, ctx, audition: playAudition });

    return () => {
      onPlayerRef.current?.(null);
      ws.destroy();
      media.destroy();
      void ctx.close().catch(() => {});
      mediaRef.current = null;
      wsRef.current = null;
      regionsRef.current = null;
      selRegionRef.current = null;
    };
  }, []);

  // Load a take. Precomputed peaks draw it immediately; playback waits for browser audio decoding.
  useEffect(() => {
    const ws = wsRef.current;
    if (!ws) return;
    let cancelled = false;
    const keep = lastSongKey.current === songKey;
    const resumeAt = keep ? ws.getCurrentTime() : 0;
    const wasPlaying = keep && ws.isPlaying();
    lastSongKey.current = songKey;
    ws.pause();
    setReady(false);
    setError(null);
    (async () => {
      try {
        const { peaks, durationSec } = await api.peaks(takeId);
        if (cancelled) return;
        // The waveform is drawn from the peaks at once; playing has to wait until the audio is decoded.
        const media = mediaRef.current!;
        const decoded = new Promise<void>((resolve, reject) => {
          const offs = [
            media.on("canplay", () => (offs.forEach((off) => off()), resolve())),
            media.on("error", (e) => (offs.forEach((off) => off()), reject(e))),
          ];
        });
        await Promise.all([ws.load(api.audioUrl(takeId), [peaks], durationSec), decoded]);
        if (cancelled) return;
        if (resumeAt > 0 && resumeAt < durationSec) ws.setTime(resumeAt);
        else setTime(0);
        setLoadedTake(takeId);
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

  useEffect(() => {
    if (!ready || loadedTake !== takeId || !auditionRequest || auditionRequest.takeId !== takeId || lastAudition.current === auditionRequest) return;
    lastAudition.current = auditionRequest;
    playAudition(auditionRequest.ranges);
  }, [ready, loadedTake, takeId, auditionRequest]);

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

  useEffect(() => {
    auditionRef.current = null;
    if (!selection) setLoop(false);
  }, [selection?.startSec, selection?.endSec]);

  // Space toggles playback unless the user is typing.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement | null;
      if (e.code === "Escape" && selectionRef.current && !(t && (t.tagName === "TEXTAREA" || t.tagName === "INPUT"))) {
        onSelectionRef.current(null);
        return;
      }
      if (e.code === "KeyL" && !e.metaKey && !e.ctrlKey && !e.altKey && !(t?.closest("input,textarea,select,button,[contenteditable=true]"))) {
        if (selectionRef.current) setLoop((v) => !v);
        e.preventDefault(); return;
      }
      if (e.code !== "Space" || e.metaKey || e.ctrlKey || e.altKey) return;
      if (t && (t.tagName === "TEXTAREA" || t.tagName === "INPUT" || t.tagName === "BUTTON" || t.tagName === "SELECT" || t.isContentEditable)) return;
      e.preventDefault();
      void wsRef.current?.playPause();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  return (
    <div className="waveform">
      <div className="arrange">
        <div className="track-head song-head">{head}</div>
        <div className={`wave-canvas ${ready ? "" : "wave-loading"}`} ref={containerRef} data-testid="waveform" />
        {tracks}
      </div>
      {error && <div className="inline-error">Could not load the audio: {error}</div>}
      <div className="transport">
        <button
          className="btn btn-round"
          onClick={() => { auditionRef.current = null; void wsRef.current?.playPause(); }}
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
              <button className="btn btn-small" disabled={!ready} onClick={() => playAudition([selection])}>
                Play selection
              </button>
              <button className="icon-btn" disabled={!ready} aria-label="Loop selection" aria-pressed={loop} title="Loop selection (L)" onClick={() => setLoop((v) => !v)}><Repeat2 size={14} strokeWidth={1.5} /></button>
              <button className="btn btn-small" disabled={!ready} title="Listen with context before and after the selection" onClick={() => playAudition([{ startSec: Math.max(0, selection.startSec - preroll), endSec: Math.min(duration, selection.endSec + preroll) }])}><Headphones size={12} strokeWidth={1.5} />Audition</button>
              <label className="preroll muted small"><select aria-label="Audition context" value={preroll} onChange={(e) => setPreroll(Number(e.target.value))}><option value={0}>No context</option><option value={1}>±1 s</option><option value={2}>±2 s</option><option value={4}>±4 s</option></select></label>
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
