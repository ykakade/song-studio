// The timeline: tracks of sound clips layered on the song, under its waveform.
//
// Clips are played in the same AudioContext as the song (see Waveform.tsx), each
// one scheduled against the song's position on that clock, so a drum loop stays
// on the beat to the sample. Dragging happens here; every finished gesture is
// one call to the server, which is also what the agent's tools end up calling.

import { AudioLines, Drum, Guitar, Magnet, Music, Undo2, Redo2, Timer, Piano, Play, Plus, Square, Trash2, Volume2, VolumeX, Waves } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState, type DragEvent as ReactDragEvent, type MouseEvent as ReactMouseEvent, type PointerEvent as ReactPointerEvent } from "react";
import type WaveSurfer from "wavesurfer.js";
import { api, type BeatGrid, type Clip, type Instrument, type SoundInfo, type Selection, type Timeline as TimelineData } from "./api.ts";
import { MusicSettings } from "./MusicSettings.tsx";
import { dbToGain, encodeWav16, peaksOf } from "./audio.ts";

/** What plays the song: the waveform's player and the audio clock it runs on. */
export interface Player {
  ws: WaveSurfer;
  ctx: AudioContext;
  audition: (ranges: Selection[]) => void;
}

const SOUND_MIME = "application/x-song-studio-sound";
const NEW_TRACK = "new";
/** Clips are scheduled this far ahead, so they start on an exact sample instead of "as soon as possible". */
const LOOKAHEAD_SEC = 0.03;
const FADE_SEC = 0.005;
const MIN_CLIP_SEC = 0.1;
/** A library sound dragged onto the timeline starts out this many bars long. */
const DROP_BARS = 4;

const icon = { size: 14, strokeWidth: 1.5 } as const;

export function InstrumentIcon({ instrument, size = 14 }: { instrument: Instrument; size?: number }) {
  const Icon = { drums: Drum, percussion: Drum, bass: Music, guitar: Guitar, keys: Piano, pad: Waves, audio: AudioLines }[instrument] ?? AudioLines;
  return <Icon size={size} strokeWidth={1.5} aria-hidden="true" />;
}

function snapTime(grid: BeatGrid, sec: number): number {
  return Math.max(0, grid.firstBeatSec + Math.round((sec - grid.firstBeatSec) / grid.beatSec) * grid.beatSec);
}

// --- playback ---------------------------------------------------------------------------

interface Loaded {
  buffer: AudioBuffer;
  peaks: number[];
}

/**
 * Loads the clips' audio and keeps it playing in step with the song.
 * Returns the loaded sounds (for drawing clip waveforms).
 */
function useClipPlayer(projectId: string, player: Player | null, timeline: TimelineData): Map<string, Loaded> {
  const [loaded, setLoaded] = useState<Map<string, Loaded>>(() => new Map());
  const loadedRef = useRef(loaded);
  loadedRef.current = loaded;
  const timelineRef = useRef(timeline);
  timelineRef.current = timeline;
  const nodes = useRef<AudioScheduledSourceNode[]>([]);

  // Fetch and decode each file once.
  const files = useMemo(() => [...new Set(timeline.clips.map((c) => c.file))].sort().join("\n"), [timeline.clips]);
  useEffect(() => {
    if (!player) return;
    let cancelled = false;
    for (const file of files ? files.split("\n") : []) {
      if (loadedRef.current.has(file)) continue;
      void (async () => {
        try {
          const res = await fetch(api.soundUrl(projectId, file));
          if (!res.ok) throw new Error(`HTTP ${res.status}`);
          const buffer = await player.ctx.decodeAudioData(await res.arrayBuffer());
          if (cancelled) return;
          setLoaded((m) => new Map(m).set(file, { buffer, peaks: peaksOf(buffer, 160) }));
        } catch (err) {
          console.warn(`could not load sound ${file}:`, err);
        }
      })();
    }
    return () => {
      cancelled = true;
    };
  }, [projectId, player, files]);

  const stop = useCallback(() => {
    for (const n of nodes.current) {
      try {
        n.stop();
      } catch {
        /* never started or already stopped */
      }
      n.disconnect();
    }
    nodes.current = [];
  }, []);

  /** Stop everything and, if the song is playing, start every clip that is still to come at its exact place. */
  const sync = useCallback(() => {
    stop();
    if (!player || !player.ws.isPlaying()) return;
    const { ctx, ws } = player;
    const t = timelineRef.current;
    const when0 = ctx.currentTime + LOOKAHEAD_SEC;
    const pos0 = ws.getCurrentTime() + LOOKAHEAD_SEC;
    for (const clip of t.clips) {
      const track = t.tracks.find((x) => x.id === clip.trackId);
      const sound = loadedRef.current.get(clip.file);
      const end = Math.min(clip.startSec + clip.durationSec, t.durationSec);
      if (!track || track.muted || !sound || end <= pos0 + 0.01) continue;
      const into = Math.max(0, pos0 - clip.startSec);
      if (!clip.loop && into >= sound.buffer.duration) continue;
      const startAt = when0 + Math.max(0, clip.startSec - pos0);
      const stopAt = when0 + (end - pos0);
      const src = ctx.createBufferSource();
      src.buffer = sound.buffer;
      src.loop = clip.loop;
      const gain = ctx.createGain();
      const level = dbToGain(track.gainDb + clip.gainDb);
      const fade = Math.min(FADE_SEC, (stopAt - startAt) / 2);
      gain.gain.setValueAtTime(0, startAt);
      gain.gain.linearRampToValueAtTime(level, startAt + fade);
      gain.gain.setValueAtTime(level, stopAt - fade);
      gain.gain.linearRampToValueAtTime(0, stopAt);
      src.connect(gain).connect(ctx.destination);
      src.onended = () => gain.disconnect();
      src.start(startAt, clip.loop ? into % sound.buffer.duration : into);
      src.stop(stopAt);
      nodes.current.push(src);
    }
  }, [player, stop]);

  useEffect(() => {
    if (!player) return;
    const offs = [player.ws.on("play", sync), player.ws.on("seeking", sync), player.ws.on("pause", stop), player.ws.on("finish", stop), player.ws.on("load", stop)];
    return () => {
      for (const off of offs) off();
      stop();
    };
  }, [player, sync, stop]);

  // The arrangement changed, or a sound finished loading, while the song plays. (Compared by content:
  // the project state is re-fetched often, and restarting the clips each time would be audible.)
  const arrangement = useMemo(() => JSON.stringify([timeline.tracks, timeline.clips]), [timeline.tracks, timeline.clips]);
  useEffect(sync, [sync, arrangement, loaded]);

  return loaded;
}

// --- one clip ---------------------------------------------------------------------------

/** The sound's waveform, repeated as often as the clip loops it. */
function ClipWave({ clip, peaks }: { clip: Clip; peaks: number[] | undefined }) {
  if (!peaks) return null;
  const repeats = clip.loop ? Math.ceil(clip.durationSec / clip.fileDurationSec - 1e-6) : 1;
  const path = peaks.map((p, i) => `M${i + 0.5} ${(1 - Math.max(0.04, p)).toFixed(3)}V${(1 + Math.max(0.04, p)).toFixed(3)}`).join("");
  return (
    <div className="clip-wave" aria-hidden="true">
      {Array.from({ length: repeats }, (_, i) => (
        <svg key={i} viewBox={`0 0 ${peaks.length} 2`} preserveAspectRatio="none" style={{ width: `${(clip.fileDurationSec / clip.durationSec) * 100}%` }}>
          <path d={path} />
        </svg>
      ))}
    </div>
  );
}

interface Draft {
  id: string;
  startSec: number;
  durationSec: number;
  trackId: string;
}

// --- the timeline -----------------------------------------------------------------------

interface Props {
  projectId: string;
  timeline: TimelineData;
  player: Player | null;
  library: SoundInfo[];
  /** The song's key, for auditioning library sounds. */
  songKey: string;
  onError: (message: string | null) => void;
  selection?: Selection | null;
  onSelect?: (selection: Selection) => void;
}

export function Timeline({ projectId, timeline, player, library, songKey, onError, selection, onSelect }: Props) {
  const { grid, durationSec } = timeline;
  const [metronome, setMetronome] = useState(false);
  const loaded = useClipPlayer(projectId, player, timeline);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [draft, setDraft] = useState<Draft | null>(null);
  const [gainDraft, setGainDraft] = useState<number | null>(null);
  const [drop, setDrop] = useState<{ trackId: string; sec: number } | null>(null);
  const [menuOpen, setMenuOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [snap, setSnap] = useState(() => {
    try {
      return window.localStorage.getItem("song-studio.snap") !== "off";
    } catch {
      return true;
    }
  });
  const lanesRef = useRef<HTMLDivElement>(null);
  const playheadRef = useRef<HTMLDivElement>(null);

  const selected = timeline.clips.find((c) => c.id === selectedId) ?? null;
  useEffect(() => setGainDraft(null), [selectedId, selected?.gainDb]);

  const run = useCallback(
    async (fn: () => Promise<unknown>) => {
      onError(null);
      try {
        await fn();
      } catch (e) {
        onError((e as Error).message);
      }
    },
    [onError],
  );

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const el = e.target as HTMLElement;
      if (el.closest("input, textarea, select, [contenteditable=true]")) return;
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "z") {
        e.preventDefault();
        const direction = e.shiftKey ? "redo" : "undo";
        if (direction === "undo" ? timeline.history.canUndo : timeline.history.canRedo) void run(() => api.arrangementStep(projectId, direction));
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [projectId, timeline.history, run]);

  useEffect(() => {
    if (!player || !metronome) return;
    const { ws, ctx } = player;
    let next = 0;
    const nodes = new Set<OscillatorNode>();
    const reset = () => {
      for (const node of nodes) { try { node.stop(); } catch {} }
      nodes.clear();
      next = Math.ceil((ws.getCurrentTime() - grid.firstBeatSec) / grid.beatSec);
    };
    reset();
    const timer = window.setInterval(() => {
      if (!ws.isPlaying()) return;
      const pos = ws.getCurrentTime();
      while (grid.firstBeatSec + next * grid.beatSec < pos - 0.02) next++;
      while (grid.firstBeatSec + next * grid.beatSec < pos + 0.1) {
        const at = ctx.currentTime + Math.max(0, grid.firstBeatSec + next * grid.beatSec - pos);
        const osc = ctx.createOscillator(), gain = ctx.createGain();
        osc.frequency.value = next % grid.beatsPerBar === 0 ? 1200 : 800;
        gain.gain.setValueAtTime(0.12, at);
        gain.gain.exponentialRampToValueAtTime(0.001, at + 0.035);
        osc.connect(gain).connect(ctx.destination);
        nodes.add(osc);
        osc.onended = () => { nodes.delete(osc); osc.disconnect(); gain.disconnect(); };
        osc.start(at); osc.stop(at + 0.04); next++;
      }
    }, 25);
    const offs = [ws.on("seeking", reset), ws.on("pause", reset), ws.on("load", reset)];
    return () => { clearInterval(timer); offs.forEach((off) => off()); reset(); };
  }, [player, metronome, grid.bpm, grid.firstBeatSec, grid.beatsPerBar]);

  // --- the playhead follows the song without re-rendering React every frame ------------------------

  useEffect(() => {
    if (!player) return;
    const place = (t: number) => {
      if (playheadRef.current) playheadRef.current.style.left = `${Math.min(100, (t / durationSec) * 100)}%`;
    };
    place(player.ws.getCurrentTime());
    const offs = [player.ws.on("timeupdate", place), player.ws.on("seeking", place)];
    return () => offs.forEach((off) => off());
  }, [player, durationSec]);

  // --- geometry -----------------------------------------------------------------------

  /** Seconds at a horizontal screen position, and the track row (or the "new track" row) under a vertical one. */
  const locate = (clientX: number, clientY: number): { sec: number; trackId: string } => {
    const lanes = lanesRef.current!;
    const rect = lanes.querySelector<HTMLElement>(".lane-overlay")!.getBoundingClientRect();
    const sec = Math.max(0, Math.min(durationSec, ((clientX - rect.left) / rect.width) * durationSec));
    let trackId = NEW_TRACK;
    for (const el of lanes.querySelectorAll<HTMLElement>("[data-track-id]")) {
      const r = el.getBoundingClientRect();
      if (clientY < r.bottom) {
        trackId = el.dataset.trackId!;
        break;
      }
    }
    return { sec, trackId };
  };

  const snapped = (sec: number, free: boolean) => (snap && !free && grid.beatSec > 0 ? snapTime(grid, sec) : sec);

  // --- dragging a clip ------------------------------------------------------------------
  //
  // The listeners sit on the window, not on the clip: a clip dragged to another
  // track is re-created inside that track's row, which would drop a pointer capture.

  const dragCleanup = useRef<(() => void) | null>(null);
  useEffect(() => () => dragCleanup.current?.(), []);
  const draftRef = useRef<Draft | null>(null);
  const showDraft = (d: Draft | null) => {
    draftRef.current = d;
    setDraft(d);
  };
  const dragEnv = useRef({ locate, snapped, run });
  dragEnv.current = { locate, snapped, run };

  const onClipDown = (e: ReactPointerEvent<HTMLElement>, clip: Clip, mode: "move" | "resize") => {
    if (e.button !== 0) return;
    e.stopPropagation();
    e.preventDefault();
    dragCleanup.current?.();
    showDraft(null);
    setSelectedId(clip.id);
    const x0 = e.clientX;
    let moved = false;

    const move = (ev: PointerEvent) => {
      const env = dragEnv.current;
      const where = env.locate(ev.clientX, ev.clientY);
      const dx = ev.clientX - x0;
      if (!moved) {
        const changedTrack = mode === "move" && where.trackId !== clip.trackId;
        if (Math.abs(dx) < 3 && !changedTrack) return;
        moved = true;
      }
      const dt = (dx / lanesRef.current!.querySelector<HTMLElement>(".lane-overlay")!.getBoundingClientRect().width) * durationSec;
      if (mode === "move") {
        const startSec = Math.min(Math.max(0, env.snapped(clip.startSec + dt, ev.altKey)), durationSec - clip.durationSec);
        showDraft({ id: clip.id, startSec, durationSec: clip.durationSec, trackId: where.trackId });
      } else {
        const max = Math.min(durationSec - clip.startSec, clip.loop ? Infinity : clip.fileDurationSec);
        const min = Math.min(max, Math.max(MIN_CLIP_SEC, grid.beatSec));
        const end = env.snapped(clip.startSec + clip.durationSec + dt, ev.altKey);
        showDraft({ id: clip.id, startSec: clip.startSec, durationSec: Math.min(max, Math.max(min, end - clip.startSec)), trackId: clip.trackId });
      }
    };

    const cleanup = () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
      window.removeEventListener("pointercancel", cancel);
      dragCleanup.current = null;
    };
    const cancel = () => {
      cleanup();
      showDraft(null);
    };
    const up = () => {
      cleanup();
      const d = draftRef.current;
      if (!moved || !d || d.id !== clip.id) {
        showDraft(null);
        return;
      }
      const change =
        mode === "resize"
          ? { durationSec: d.durationSec }
          : { startSec: d.startSec, ...(d.trackId === NEW_TRACK ? { newTrack: true } : d.trackId !== clip.trackId ? { trackId: d.trackId } : {}) };
      // The draft stays on screen until the server has answered, so the clip does not jump back for a moment.
      void dragEnv.current
        .run(() => api.updateClip(projectId, clip.id, change))
        .finally(() => {
          if (draftRef.current?.id === clip.id) showDraft(null);
        });
    };

    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
    window.addEventListener("pointercancel", cancel);
    dragCleanup.current = cleanup;
  };

  // --- adding sounds ----------------------------------------------------------------------

  const addFromLibrary = (sound: SoundInfo, at: { sec: number; trackId?: string } | null) => {
    const bar = grid.beatSec * grid.beatsPerBar;
    // Dropped: a few bars where it landed. Clicked: from the playhead (or the first beat) to the end.
    const playhead = player?.ws.getCurrentTime() ?? 0;
    const startSec = at ? at.sec : playhead > 0.05 ? snapped(playhead, false) : undefined;
    const endSec = at && sound.loop ? Math.min(durationSec, at.sec + DROP_BARS * bar) : undefined;
    setMenuOpen(false);
    void run(async () => {
      const r = await api.addClip(projectId, {
        sound: sound.id,
        startSec: startSec !== undefined ? Math.min(startSec, durationSec - 0.2) : undefined,
        endSec,
        ...(at?.trackId === NEW_TRACK ? { newTrack: true } : at?.trackId ? { trackId: at.trackId } : {}),
      });
      setSelectedId(r.clip.id);
    });
  };

  const importFiles = async (files: File[], at: { sec: number; trackId: string }) => {
    if (!player) return;
    setBusy(true);
    try {
      let sec = at.sec;
      for (const file of files) {
        let buffer: AudioBuffer;
        try {
          buffer = await player.ctx.decodeAudioData(await file.arrayBuffer());
        } catch {
          throw new Error(`${file.name} is not an audio file this browser can read`);
        }
        const r = await api.importClip(projectId, file.name, encodeWav16(buffer), { startSec: Math.min(sec, durationSec - 0.2), trackId: at.trackId === NEW_TRACK ? undefined : at.trackId });
        setSelectedId(r.clip.id);
        sec += r.clip.durationSec;
      }
    } finally {
      setBusy(false);
    }
  };

  const accepts = (e: ReactDragEvent) => e.dataTransfer.types.includes(SOUND_MIME) || e.dataTransfer.types.includes("Files");

  const onDragOver = (e: ReactDragEvent) => {
    if (!accepts(e)) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = "copy";
    const where = locate(e.clientX, e.clientY);
    setDrop({ trackId: where.trackId, sec: snapped(where.sec, e.altKey) });
  };

  const onDrop = (e: ReactDragEvent) => {
    if (!accepts(e)) return;
    e.preventDefault();
    setDrop(null);
    const where = locate(e.clientX, e.clientY);
    const at = { sec: Math.min(snapped(where.sec, e.altKey), durationSec - 0.2), trackId: where.trackId };
    const soundId = e.dataTransfer.getData(SOUND_MIME);
    const sound = library.find((s) => s.id === soundId);
    if (sound) addFromLibrary(sound, at);
    else if (e.dataTransfer.files.length) void run(() => importFiles([...e.dataTransfer.files], at));
  };

  // --- selected clip: delete, volume -----------------------------------------------------------

  const remove = useCallback(
    (clipId: string) => {
      setSelectedId(null);
      void run(() => api.removeClip(projectId, clipId));
    },
    [projectId, run],
  );

  useEffect(() => {
    if (!selectedId) return;
    const onKey = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement | null;
      if (t && (t.tagName === "TEXTAREA" || t.tagName === "INPUT" || t.isContentEditable)) return;
      if (e.key === "Delete" || e.key === "Backspace") {
        e.preventDefault();
        remove(selectedId);
      } else if (e.key === "Escape") {
        setSelectedId(null);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [selectedId, remove]);

  // The sound menu closes on a click anywhere else.
  useEffect(() => {
    if (!menuOpen) return;
    const close = (e: PointerEvent) => {
      if (!(e.target as HTMLElement | null)?.closest?.(".track-foot .track-head")) setMenuOpen(false);
    };
    window.addEventListener("pointerdown", close);
    return () => window.removeEventListener("pointerdown", close);
  }, [menuOpen]);

  const toggleSnap = () =>
    setSnap((v) => {
      try {
        window.localStorage.setItem("song-studio.snap", v ? "off" : "on");
      } catch {
        /* not remembered */
      }
      return !v;
    });

  // --- render ---------------------------------------------------------------------------

  const pct = (sec: number) => `${(sec / durationSec) * 100}%`;
  const shownClip = (c: Clip): Clip => (draft?.id === c.id ? { ...c, startSec: draft.startSec, durationSec: draft.durationSec, trackId: draft.trackId } : c);
  const clips = timeline.clips.map(shownClip);
  const barPct = ((grid.beatSec * grid.beatsPerBar) / durationSec) * 100;

  const renderClip = (clip: Clip) => {
    const original = timeline.clips.find((c) => c.id === clip.id)!;
    return (
      <div
        key={clip.id}
        className={`clip ${clip.id === selectedId ? "clip-selected" : ""} ${draft?.id === clip.id ? "clip-dragging" : ""}`}
        style={{ left: pct(clip.startSec), width: pct(clip.durationSec) }}
        data-testid="clip"
        data-clip-id={clip.id}
        data-sound={clip.sound}
        data-start={clip.startSec.toFixed(3)}
        data-duration={clip.durationSec.toFixed(3)}
        title={`${clip.name} · ${clip.startSec.toFixed(2)}–${(clip.startSec + clip.durationSec).toFixed(2)} s`}
        onPointerDown={(e) => onClipDown(e, original, "move")}
        onClick={(e) => e.stopPropagation()}
      >
        <ClipWave clip={clip} peaks={loaded.get(clip.file)?.peaks} />
        <span className="clip-label">
          <InstrumentIcon instrument={clip.instrument} size={12} />
          <span>{clip.name}</span>
        </span>
        <span className="clip-handle" data-testid="clip-resize" onPointerDown={(e) => onClipDown(e, original, "resize")} title="Drag to make it longer or shorter" />
      </div>
    );
  };

  const seek = (e: ReactMouseEvent) => {
    setSelectedId(null);
    if (player) player.ws.setTime(locate(e.clientX, e.clientY).sec);
  };

  const level = gainDraft ?? selected?.gainDb ?? 0;

  return (
    <div className="tracks" data-testid="timeline" onDragOver={onDragOver} onDragLeave={() => setDrop(null)} onDrop={onDrop}>
      {timeline.chords.length > 0 && <div className="track chord-strip"><div className="track-head"><span className="muted small">Chords</span></div><div className="chord-lane">{timeline.chords.map((c, i) => <button key={i} className="chord-region" title={`${c.chord} · ${c.startSec.toFixed(2)}–${c.endSec.toFixed(2)} s`} style={{ left: pct(c.startSec), width: pct(c.endSec - c.startSec) }} onClick={() => onSelect?.(c)}>{c.chord}</button>)}</div></div>}
      <div className="track-rows" ref={lanesRef}>
        <div
          className="lane-overlay"
          aria-hidden="true"
          style={grid.detected || grid.manual ? { backgroundSize: `${barPct}% 100%`, backgroundPosition: `${(grid.firstBeatSec / durationSec) * 100 * (100 / (100 - barPct))}% 0` } : { backgroundImage: "none" }}
        >
          <div className="playhead" ref={playheadRef} />
          {drop && <div className="drop-line" style={{ left: pct(drop.sec) }} />}
        </div>
        {timeline.tracks.map((track) => (
          <div key={track.id} className={`track ${track.muted ? "track-muted" : ""}`} data-testid="track" data-track-name={track.name}>
            <div className="track-head">
              <span className="track-name" title={track.name}>
                {track.name}
              </span>
              <button
                className="icon-btn"
                onClick={() => void run(() => api.updateTrack(projectId, track.id, { muted: !track.muted }))}
                aria-pressed={track.muted}
                aria-label={track.muted ? `Unmute ${track.name}` : `Mute ${track.name}`}
                title={track.muted ? "Unmute" : "Mute"}
                data-testid="track-mute"
              >
                {track.muted ? <VolumeX {...icon} /> : <Volume2 {...icon} />}
              </button>
            </div>
            <div className={`lane ${drop?.trackId === track.id ? "lane-drop" : ""}`} data-track-id={track.id} onClick={seek}>
              {clips.filter((c) => c.trackId === track.id).map(renderClip)}
            </div>
          </div>
        ))}
        {
          <div className="track">
            <div className="track-head">
              <span className="track-name muted">New track</span>
            </div>
            <div className={`lane new-track-lane ${drop?.trackId === NEW_TRACK ? "lane-drop" : ""}`} data-track-id={NEW_TRACK} data-testid="new-track-lane">
              {clips.filter((c) => c.trackId === NEW_TRACK).map(renderClip)}
              {!clips.some((c) => c.trackId === NEW_TRACK) && <span className="muted small">Drop a sound or audio file here</span>}
            </div>
          </div>
        }
      </div>

      <div className="track track-foot">
        <div className="track-head">
          <button className="btn btn-small" onClick={() => setMenuOpen((v) => !v)} aria-expanded={menuOpen} data-testid="add-sound">
            <Plus size={12} strokeWidth={1.5} />
            Add sound
          </button>
          {menuOpen && (
            <div className="sound-menu" role="dialog" aria-label="Sounds">
              <SoundList sounds={library} grid={grid} songKey={songKey} onAdd={(s) => addFromLibrary(s, null)} />
            </div>
          )}
        </div>
        <div className="track-tools">
          {selected ? (
            <>
              <span className="clip-name" data-testid="selected-clip">
                <InstrumentIcon instrument={selected.instrument} />
                {selected.name}
                <span className="mono muted">
                  {selected.startSec.toFixed(2)}–{(selected.startSec + selected.durationSec).toFixed(2)} s
                </span>
              </span>
              <label className="volume" title="Volume of this clip">
                <Volume2 {...icon} />
                <input
                  type="range"
                  min={-36}
                  max={12}
                  step={1}
                  value={level}
                  aria-label="Clip volume in dB"
                  onChange={(e) => setGainDraft(Number(e.target.value))}
                  onPointerUp={() => gainDraft !== null && gainDraft !== selected.gainDb && void run(() => api.updateClip(projectId, selected.id, { gainDb: gainDraft }))}
                  onKeyUp={() => gainDraft !== null && gainDraft !== selected.gainDb && void run(() => api.updateClip(projectId, selected.id, { gainDb: gainDraft }))}
                />
                <span className="mono">{level > 0 ? `+${level}` : level} dB</span>
              </label>
              <button className="icon-btn" onClick={() => remove(selected.id)} aria-label={`Remove ${selected.name}`} title="Remove (Delete)" data-testid="clip-remove">
                <Trash2 {...icon} />
              </button>
            </>
          ) : (
            <span className="muted small">
              {busy ? "Adding your file" : timeline.clips.length ? "Drag a clip to move it, its right edge to resize it" : "Drag a sound here, drop an audio file, or ask the agent to add one"}
            </span>
          )}
          <span className="spacer" />
          <button className="icon-btn" aria-label="Undo arrangement" title="Undo arrangement (⌘Z / Ctrl+Z)" disabled={!timeline.history.canUndo} onClick={() => void run(() => api.arrangementStep(projectId, "undo"))}><Undo2 {...icon} /></button>
          <button className="icon-btn" aria-label="Redo arrangement" title="Redo arrangement (⌘⇧Z / Ctrl+Shift+Z)" disabled={!timeline.history.canRedo} onClick={() => void run(() => api.arrangementStep(projectId, "redo"))}><Redo2 {...icon} /></button>
          <button className="icon-btn" aria-label="Metronome" title="Metronome (listening only)" aria-pressed={metronome} onClick={() => setMetronome((v) => !v)}><Timer {...icon} /></button>
          <span className="mono muted small" title={grid.manual ? "Tempo and downbeat set manually" : grid.detected ? "Tempo measured from the song's audio" : "The beat could not be found in the audio; this is the tempo that was asked for"} data-testid="grid">
            {grid.bpm.toFixed(grid.detected ? 1 : 0)} bpm{grid.manual ? " (manual)" : grid.detected ? "" : " (assumed)"}
          </span>
          <button className="icon-btn" onClick={toggleSnap} aria-pressed={snap} aria-label="Snap to the beat" title={snap ? "Snapping to the beat. Hold Alt to place freely" : "Snap to the beat is off"} data-testid="snap">
            <Magnet {...icon} />
          </button>
        </div>
      </div>
      <MusicSettings key={JSON.stringify([grid, timeline.chords])} projectId={projectId} timeline={timeline} selection={selection ?? null} onError={onError} />
    </div>
  );
}

// --- the sound library ------------------------------------------------------------------

/** The library as a list: drag a row onto the timeline, or press its plus. */
export function SoundList({ sounds, grid, songKey, onAdd }: { sounds: SoundInfo[]; grid: BeatGrid | null; songKey: string; onAdd?: (sound: SoundInfo) => void }) {
  const [playing, setPlaying] = useState<string | null>(null);
  const audio = useRef<HTMLAudioElement | null>(null);
  useEffect(
    () => () => {
      audio.current?.pause();
    },
    [],
  );

  const audition = (s: SoundInfo) => {
    audio.current?.pause();
    if (playing === s.id) {
      setPlaying(null);
      return;
    }
    const a = new Audio(api.previewUrl(s.id, { bpm: grid?.bpm ?? 100, key: songKey, beatsPerBar: grid?.beatsPerBar ?? 4 }));
    a.onended = () => setPlaying((p) => (p === s.id ? null : p));
    audio.current = a;
    setPlaying(s.id);
    void a.play().catch(() => setPlaying(null));
  };

  return (
    <ul className="sound-list" data-testid="sound-list">
      {sounds.map((s) => (
        <li
          key={s.id}
          className="sound-row"
          draggable
          onDragStart={(e) => {
            e.dataTransfer.setData(SOUND_MIME, s.id);
            e.dataTransfer.effectAllowed = "copy";
          }}
          title={`${s.description} Drag it onto the timeline`}
          data-testid="sound"
          data-sound={s.id}
        >
          <InstrumentIcon instrument={s.instrument} />
          <span className="sound-name">{s.name}</span>
          <button className="icon-btn" onClick={() => audition(s)} aria-label={playing === s.id ? `Stop ${s.name}` : `Listen to ${s.name}`} title={playing === s.id ? "Stop" : "Listen"}>
            {playing === s.id ? <Square size={10} strokeWidth={0} fill="currentColor" /> : <Play size={10} strokeWidth={0} fill="currentColor" />}
          </button>
          {onAdd && (
            <button className="icon-btn" onClick={() => onAdd(s)} aria-label={`Add ${s.name} to the timeline`} title="Add to the timeline" data-testid="sound-add">
              <Plus {...icon} />
            </button>
          )}
        </li>
      ))}
    </ul>
  );
}
