// The studio service: every operation the product offers, in one place.
// The agent's tools and the HTTP API both call these methods, so "what the
// LLM can do" and "what the API can do" are the same code path.

import { compareOutside, spliceRepaint } from "./splice.ts";
import { computePeaks } from "./wav.ts";
import { createHash, randomInt } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { AceStepClient } from "./acestep.ts";
import { estimateBeatGrid, snapToBeat } from "./beats.ts";
import type { Config } from "./config.ts";
import type { ProjectStore } from "./store.ts";
import type { EventBus } from "./events.ts";
import { countSungWords, durationForWords, wordBudget } from "./lyrics.ts";
import { type MixResult, renderMix } from "./mix.ts";
import type { JobQueue } from "./queue.ts";
import { findSound, INSTRUMENT_NAMES, renderSound, SOUND_LIBRARY, soundFileName } from "./sounds.ts";
import { type Arrangement, newId, slugify } from "./store.ts";
import type { BeatGrid, ChordRegion, JoinOptions, Clip, Job, Marker, Project, ProjectSummary, Selection, Take, TakeParams, TakeTiming, Timeline, Track } from "./types.ts";
import { decodeWav, durationSeconds, encodeWav, type WavAudio, WavFormatError } from "./wav.ts";

export class StudioError extends Error {
  readonly code: "not_found" | "invalid" | "conflict" | "model_server_unreachable";
  constructor(code: StudioError["code"], message: string) {
    super(message);
    this.name = "StudioError";
    this.code = code;
  }
}

export interface GenerateInput {
  title: string;
  stylePrompt: string;
  lyrics: string;
  bpm: number;
  key: string;
  durationSec: number;
  timeSignature?: string;
  vocalLanguage?: string;
  seed?: number;
  changeSummary?: string;
}

export interface RepaintInput {
  joins?: JoinOptions;
  takeId: string;
  startSec: number;
  endSec: number;
  /** The complete lyrics of the song after the change. */
  lyrics: string;
  stylePrompt?: string;
  seed?: number;
  changeSummary?: string;
}

export interface AddSoundInput {
  /** A sound id from the library (server/sounds.ts). */
  sound: string;
  /** Default: the song's first beat. */
  startSec?: number;
  /** Default: the end of the song for a loop, the sound's own length for a one-shot. */
  endSec?: number;
  /** Put it on this track. Default: a track of the same instrument with room, else a new one. */
  trackId?: string;
  newTrack?: boolean;
  gainDb?: number;
  /** Move the start (and end) onto the nearest beat. */
  snap?: boolean;
}

export interface ClipPatch {
  startSec?: number;
  endSec?: number;
  durationSec?: number;
  trackId?: string;
  newTrack?: boolean;
  gainDb?: number;
  snap?: boolean;
}

export const MIN_DURATION_SEC = 10;
export const MIN_CLIP_SEC = 0.1;
const MAX_CLIPS = 64;
const MAX_TRACKS = 16;
const MAX_IMPORT_SEC = 600;
const GAIN_RANGE_DB = [-36, 12] as const;
export const MIN_REPAINT_SEC = 0.5;
const TIME_SIGNATURES = new Set(["2", "3", "4", "6"]);

function invalid(message: string): never {
  throw new StudioError("invalid", message);
}

function text(v: unknown, name: string, maxLen: number): string {
  if (typeof v !== "string" || !v.trim()) invalid(`${name} must be a non-empty string`);
  const t = (v as string).trim();
  if (t.length > maxLen) invalid(`${name} is too long (${t.length} characters, the limit is ${maxLen})`);
  return t;
}

function finite(v: unknown, name: string): number {
  if (typeof v !== "number" || !Number.isFinite(v)) invalid(`${name} must be a number`);
  return v as number;
}

function round3(v: number): number {
  return Math.round(v * 1000) / 1000;
}

function newSeed(): number {
  return randomInt(1, 2 ** 31 - 1);
}

export class Studio {
  readonly store: ProjectStore;
  readonly config: Config;
  readonly ace: AceStepClient;
  readonly bus: EventBus;
  readonly queue: JobQueue;

  constructor(deps: { store: ProjectStore; config: Config; ace: AceStepClient; bus: EventBus; queue: JobQueue }) {
    this.store = deps.store;
    this.config = deps.config;
    this.ace = deps.ace;
    this.bus = deps.bus;
    this.queue = deps.queue;
  }

  // --- projects -------------------------------------------------------------------

  createProject(title?: string): Project {
    return this.store.createProject(title?.trim() || "Untitled song");
  }

  listProjects(): ProjectSummary[] {
    return this.store.listProjects();
  }

  project(projectId: string): Project {
    const p = this.store.getProject(projectId);
    if (!p) throw new StudioError("not_found", `project ${projectId} does not exist`);
    return p;
  }

  renameProject(projectId: string, title: string): Project {
    this.project(projectId);
    this.store.updateProject(projectId, { title: text(title, "title", 120) });
    this.bus.emit(projectId, { type: "state" });
    return this.project(projectId);
  }

  async deleteProject(projectId: string): Promise<void> {
    this.project(projectId);
    if (this.store.listJobsByStatus(["queued", "running"], projectId).length) {
      throw new StudioError("conflict", "this project has a job in progress; wait for it to finish before deleting");
    }
    this.store.deleteProject(projectId);
  }

  take(projectId: string, takeId: string): Take {
    const t = this.store.getTake(takeId);
    if (!t || t.projectId !== projectId) throw new StudioError("not_found", `take ${takeId} does not exist in this project`);
    return t;
  }

  currentTake(projectId: string): Take | null {
    const p = this.project(projectId);
    return p.currentTakeId ? this.store.getTake(p.currentTakeId) : null;
  }

  markers(projectId: string): Marker[] {
    const cur = this.currentTake(projectId);
    return cur ? this.store.getMarkers(projectId, cur.rootTakeId) : [];
  }

  snapshot(projectId: string): {
    project: Project;
    takes: Take[];
    markers: Marker[];
    activeJobs: Job[];
    timing: TakeTiming | null;
    analysing: boolean;
    lyricsDraft: string | null;
    timeline: Timeline | null;
  } {
    const project = this.project(projectId);
    const takes = this.store.listTakes(projectId);
    const cur = takes.find((t) => t.id === project.currentTakeId) ?? null;
    return {
      project,
      takes,
      markers: this.markers(projectId),
      activeJobs: this.store.listJobsByStatus(["queued", "running"], projectId),
      timing: cur ? this.store.readTiming(cur) : null,
      analysing: cur ? this.queue.isAnalysing(cur.id) : false,
      lyricsDraft: this.store.lyricsDraft(projectId),
      timeline: this.timeline(projectId),
    };
  }

  /** Where the lyrics are in a take (null until it has been analysed). */
  timing(projectId: string, takeId: string): TakeTiming | null {
    return this.store.readTiming(this.take(projectId, takeId));
  }

  /** Analyse a finished take again (or for the first time). */
  analyseTake(projectId: string, takeId: string): { queued: boolean } {
    const t = this.take(projectId, takeId);
    if (t.status !== "done") invalid(`take ${takeId} is ${t.status}; only a finished take can be analysed`);
    if (!this.queue.transcriber) invalid("finding the words is switched off (SONG_STUDIO_TIMING=off)");
    return { queued: this.queue.requestAnalysis(t.id, { force: true }) };
  }

  // --- selection, markers, current take -------------------------------------------------

  /** A line in the chat for the person (not sent to the chat model). */
  note(projectId: string, text: string): void {
    const message = this.store.insertMessage(projectId, { role: "event", kind: "info", text });
    this.bus.emit(projectId, { type: "chat.message", message });
  }

  /** Remember the waveform selection that came with a chat message (null clears it). */
  setSelection(projectId: string, selection: Selection | null): Selection | null {
    const cur = this.currentTake(projectId);
    let clean: Selection | null = null;
    if (selection && cur?.durationSec) {
      const s = Math.max(0, finite(selection.startSec, "selection start"));
      const e = Math.min(cur.durationSec, finite(selection.endSec, "selection end"));
      if (e - s >= 0.05) clean = { startSec: round3(s), endSec: round3(e) };
    }
    this.store.updateProject(projectId, { selection: clean });
    return clean;
  }

  setMarkers(projectId: string, markers: Marker[]): Marker[] {
    const cur = this.currentTake(projectId);
    if (!cur || cur.status !== "done" || !cur.durationSec) invalid("there is no finished take yet, so there is nothing to put markers on");
    if (!Array.isArray(markers)) invalid("markers must be a list");
    if (markers.length > 40) invalid("too many markers (the limit is 40)");
    const seen = new Set<string>();
    const clean = markers.map((m, i) => {
      const label = text(m?.label, `markers[${i}].label`, 40);
      const startSec = finite(m?.startSec, `markers[${i}].start`);
      let endSec = finite(m?.endSec, `markers[${i}].end`);
      if (endSec > cur.durationSec! && endSec <= cur.durationSec! + 0.25) endSec = cur.durationSec!;
      if (startSec < 0 || endSec > cur.durationSec!) invalid(`marker "${label}" (${startSec}–${endSec} s) is outside the song (0–${cur.durationSec} s)`);
      if (endSec - startSec < 0.1) invalid(`marker "${label}" must end after it starts`);
      const k = label.toLowerCase();
      if (seen.has(k)) invalid(`two markers are both called "${label}"; give them different names (for example "verse 1", "verse 2")`);
      seen.add(k);
      return { label, startSec: round3(startSec), endSec: round3(endSec) };
    });
    clean.sort((a, b) => a.startSec - b.startSec);
    this.store.replaceMarkers(projectId, cur.rootTakeId, clean);
    this.store.updateProject(projectId, {});
    this.bus.emit(projectId, { type: "state" });
    return clean;
  }

  /** Make an existing, finished take the current one ("revert"). Never changes any take. */
  setCurrentTake(projectId: string, takeId: string): Take {
    const t = this.take(projectId, takeId);
    if (t.status !== "done") invalid(`take ${takeId} is ${t.status}; only a finished take can be made current`);
    this.store.updateProject(projectId, { currentTakeId: t.id });
    this.bus.emit(projectId, { type: "state" });
    return t;
  }

  // --- the timeline: sounds layered on the song --------------------------------------------
  //
  // Clips never touch a take. They belong to the song (the lineage of a first
  // take, like section markers), are played on top of whichever take is
  // current, and take effect at once: no job, no model.

  /** The finished current take and the first take of its song, or null. */
  private song(projectId: string): { cur: Take; root: Take } | null {
    const cur = this.currentTake(projectId);
    if (!cur || cur.status !== "done" || !cur.durationSec || !cur.sampleRate) return null;
    const root = cur.rootTakeId === cur.id ? cur : this.store.getTake(cur.rootTakeId);
    return { cur, root: root && root.status === "done" ? root : cur };
  }

  private requireSong(projectId: string): { cur: Take; root: Take } {
    return this.song(projectId) ?? invalid("there is no finished take yet, so there is no song to put sounds on");
  }

  /**
   * Where the beats are. Measured once from the song's first take and kept next to
   * it (takes/take-NNN.beats.json): repaints keep the tempo, so one grid serves the whole song.
   */
  beatGrid(take: Take): BeatGrid {
    const beatsPerBar = Number(take.params.timeSignature) || 4;
    const saved = this.store.readBeats(take);
    if (saved) return { ...saved, beatsPerBar };
    let grid: BeatGrid = { bpm: take.params.bpm, beatSec: 60 / take.params.bpm, firstBeatSec: 0, beatsPerBar, detected: false };
    const file = this.store.takeAudioPath(take.id);
    if (file) {
      try {
        grid = estimateBeatGrid(decodeWav(readFileSync(file)), take.params.bpm, beatsPerBar);
        this.store.writeBeats(take, grid);
      } catch (err) {
        console.warn(`[beats] could not analyse take ${take.seq}: ${err instanceof Error ? err.message : err}`);
      }
    }
    return grid;
  }

  timeline(projectId: string): Timeline | null {
    const song = this.song(projectId);
    if (!song) return null;
    const durationSec = song.cur.durationSec!;
    const a = this.store.readArrangement(projectId, song.cur.rootTakeId);
    // A clip left hanging past the end (a hand edit) is shown and played only up to the end.
    const clips = a.clips
      .filter((c) => c.startSec < durationSec - 0.01)
      .map((c) => ({ ...c, durationSec: round3(Math.min(c.durationSec, durationSec - c.startSec)) }));
    const h = this.store.arrangementHistory(projectId, song.cur.rootTakeId);
    return { tracks: a.tracks, clips, chords: a.chords ?? [], grid: a.grid ?? this.beatGrid(song.root), durationSec, history: { canUndo: h.past.length > 0, canRedo: h.future.length > 0 } };
  }

  private saveArrangement(projectId: string, rootTakeId: string, a: Arrangement, event: string, details: Record<string, unknown>): Timeline {
    const used = new Set(a.clips.map((c) => c.trackId));
    this.fitClips(projectId, a);
    this.store.writeArrangement(projectId, rootTakeId, { ...a, tracks: a.tracks.filter((t) => used.has(t.id)) });
    this.store.log(projectId, event, details);
    this.store.updateProject(projectId, {});
    this.bus.emit(projectId, { type: "state" });
    return this.timeline(projectId)!;
  }

  arrangementStep(projectId: string, direction: "undo" | "redo"): Timeline {
    const { cur } = this.requireSong(projectId);
    const h = this.store.arrangementHistory(projectId, cur.rootTakeId);
    const target = (direction === "undo" ? h.past : h.future).at(-1);
    if (!target) throw new StudioError("conflict", `nothing to ${direction}`);
    this.store.writeArrangement(projectId, cur.rootTakeId, target, direction);
    this.store.log(projectId, `arrangement_${direction}`, {});
    this.bus.emit(projectId, { type: "state" });
    return this.timeline(projectId)!;
  }

  setMusic(projectId: string, input: { bpm: number; firstBeatSec: number; chords: ChordRegion[] }): Timeline {
    const { cur } = this.requireSong(projectId);
    if (!input || typeof input !== "object") invalid("music settings must be an object");
    const bpm = finite(input.bpm, "bpm");
    const firstBeatSec = finite(input.firstBeatSec, "downbeat");
    if (bpm < 40 || bpm > 220 || firstBeatSec < 0 || firstBeatSec >= cur.durationSec!) invalid("tempo must be 40–220 bpm and the downbeat must be inside the song");
    if (!Array.isArray(input.chords) || input.chords.length > 64) invalid("use at most 64 chord regions");
    const chords = input.chords.map((c) => {
      const startSec = finite(c?.startSec, "chord start"), endSec = finite(c?.endSec, "chord end");
      const chord = text(c?.chord, "chord", 12);
      if (!/^[A-G](?:#|b)?(?:m|maj|min| Major| Minor)?$/.test(chord)) invalid(`unsupported chord "${chord}"; use major or minor, for example C, Am, F# or Bb`);
      if (startSec < 0 || endSec > cur.durationSec! || endSec <= startSec) invalid("chord regions must fit inside the song");
      return { startSec, endSec, chord };
    }).sort((a, b) => a.startSec - b.startSec);
    if (chords.some((c, i) => i > 0 && c.startSec < chords[i - 1].endSec)) invalid("chord regions cannot overlap");
    const a = this.store.readArrangement(projectId, cur.rootTakeId);
    a.grid = { ...this.timeline(projectId)!.grid, bpm, beatSec: 60 / bpm, firstBeatSec, detected: false, manual: true };
    a.chords = chords;
    return this.saveArrangement(projectId, cur.rootTakeId, a, "music_changed", { bpm, firstBeatSec, chords });
  }

  /** Bake harmonic changes into library files so browser playback and WAV export share the same audio. */
  private fitClips(projectId: string, a: Arrangement): void {
    const { cur, root } = this.requireSong(projectId);
    const grid = a.grid ?? this.beatGrid(root);
    for (const clip of a.clips) {
      const sound = findSound(clip.sound);
      if (!sound) continue; // Imported recordings are never retimed or repitched.
      if (!a.grid && !(a.chords?.length) && !clip.file.startsWith("fit-")) continue;
      const options = { bpm: grid.bpm, beatsPerBar: grid.beatsPerBar, sampleRate: cur.sampleRate!, key: cur.params.key };
      const file = `fit-${createHash("sha256").update(JSON.stringify([sound.id, options, a.chords, clip.startSec, clip.durationSec])).digest("hex").slice(0, 24)}.wav`;
      if (existsSync(this.store.soundPath(projectId, file)!)) {
        clip.file = file;
        clip.fileDurationSec = durationSeconds(decodeWav(readFileSync(this.store.soundPath(projectId, file)!)));
        continue;
      }
      const cache = new Map<string, WavAudio>();
      const audioFor = (key: string) => {
        if (!cache.has(key)) cache.set(key, renderSound(sound.id, { ...options, key }));
        return cache.get(key)!;
      };
      const base = audioFor(options.key);
      const frames = sound.loop ? Math.round(clip.durationSec * base.sampleRate) : base.samples.length / base.channels;
      const samples = new Int16Array(frames * base.channels);
      const blend = Math.round(0.005 * base.sampleRate);
      let previous = base, active = base, changedAt = -blend;
      for (let f = 0; f < frames; f++) {
        const sec = clip.startSec + f / base.sampleRate;
        const region = sound.pitched ? a.chords?.find((c) => sec >= c.startSec && sec < c.endSec) : null;
        const next = audioFor(region?.chord ?? options.key);
        if (next !== active) { previous = active; active = next; changedAt = f; }
        const w = Math.min(1, (f - changedAt) / Math.max(1, blend));
        for (let c = 0; c < base.channels; c++) {
          const i = f * base.channels + c;
          samples[i] = Math.round(previous.samples[i % previous.samples.length] * (1 - w) + active.samples[i % active.samples.length] * w);
        }
      }
      this.store.writeSound(projectId, file, encodeWav({ ...base, samples }));
      clip.file = file;
      clip.fileDurationSec = frames / base.sampleRate;
    }
  }

  saveLyrics(projectId: string, lyrics: unknown): void {
    this.project(projectId);
    if (typeof lyrics !== "string" || lyrics.length > 6000) invalid("lyrics must be text, up to 6000 characters");
    this.store.saveLyricsDraft(projectId, lyrics);
    this.bus.emit(projectId, { type: "state" });
  }

  private joinOptions(input?: JoinOptions): JoinOptions {
    const crossfadeMs = input?.crossfadeMs ?? 50;
    if (!Number.isFinite(crossfadeMs) || crossfadeMs < 0 || crossfadeMs > 500) invalid("crossfade must be between 0 and 500 ms");
    if (input?.matchLevel !== undefined && typeof input.matchLevel !== "boolean") invalid("matchLevel must be true or false");
    return { crossfadeMs, matchLevel: input?.matchLevel ?? false };
  }

  refineJoins(projectId: string, takeId: string, options: JoinOptions): Take {
    const source = this.take(projectId, takeId);
    if (source.status !== "done" || !source.params.repaint || !source.parentTakeId || source.checks?.status !== "verified") invalid("only a verified repaint can have its joins refined");
    const joins = this.joinOptions(options);
    const parent = this.take(projectId, source.parentTakeId!);
    const before = decodeWav(readFileSync(this.store.takeAudioPath(parent.id)!));
    const edited = decodeWav(readFileSync(this.store.takeAudioPath(source.id)!));
    const result = spliceRepaint(before, edited, { ...source.params.repaint!, ...joins });
    const take = this.store.insertTake({ projectId, parentTakeId: source.id, rootTakeId: source.rootTakeId, kind: "repaint", params: { ...source.params, joins }, changeSummary: `Refined joins · ${joins.crossfadeMs} ms${joins.matchLevel ? " · level matched" : ""}` });
    const file = this.store.takePath(take, ".wav");
    writeFileSync(file, encodeWav(result.audio));
    const verified = compareOutside(decodeWav(readFileSync(file)), edited, result.checks.startFrame, result.checks.endFrame);
    if (verified.mismatches) throw new StudioError("invalid", "join adjustment changed audio outside the range");
    writeFileSync(this.store.takePath(take, ".peaks.json"), JSON.stringify(computePeaks(result.audio, 1800)));
    this.store.finaliseTake(take.id, { audioFile: file.split("/").at(-1)!, durationSec: durationSeconds(result.audio), sampleRate: result.audio.sampleRate, checks: result.checks });
    this.store.updateProject(projectId, { currentTakeId: take.id });
    this.store.log(projectId, "joins_refined", { take: take.id, source: source.id, joins });
    this.queue.requestAnalysis(take.id);
    this.bus.emit(projectId, { type: "state" });
    return this.store.getTake(take.id)!;
  }

  /** The track a new clip goes on: the one asked for, one of its instrument with room, or a new one. */
  private placeOnTrack(a: Arrangement, want: { trackId?: string; newTrack?: boolean }, instrument: Clip["instrument"], startSec: number, endSec: number): Track {
    if (want.trackId && !want.newTrack) {
      const t = a.tracks.find((x) => x.id === want.trackId);
      if (!t) invalid(`there is no track ${want.trackId}; tracks: ${a.tracks.map((x) => `${x.id} ("${x.name}")`).join(", ") || "none"}`);
      return t!;
    }
    const base = INSTRUMENT_NAMES[instrument];
    if (!want.newTrack) {
      const free = a.tracks.find(
        (t) => t.name.startsWith(base) && !a.clips.some((c) => c.trackId === t.id && c.startSec < endSec - 0.001 && c.startSec + c.durationSec > startSec + 0.001),
      );
      if (free) return free;
    }
    if (a.tracks.length >= MAX_TRACKS) invalid(`the timeline already has ${MAX_TRACKS} tracks; put the sound on an existing track`);
    let name = base;
    for (let i = 2; a.tracks.some((t) => t.name === name); i++) name = `${base} ${i}`;
    const track: Track = { id: newId("tr", 2), name, muted: false, gainDb: 0 };
    a.tracks.push(track);
    return track;
  }

  private static gain(v: unknown, fallback: number): number {
    if (v === undefined || v === null) return fallback;
    const g = finite(v, "volume (dB)");
    return Math.round(Math.min(GAIN_RANGE_DB[1], Math.max(GAIN_RANGE_DB[0], g)) * 10) / 10;
  }

  /** Put a sound from the library on the timeline. Takes effect immediately. */
  addSound(projectId: string, input: AddSoundInput): { clip: Clip; timeline: Timeline } {
    const { cur, root } = this.requireSong(projectId);
    const sound = findSound(String(input.sound ?? "").trim());
    if (!sound) invalid(`there is no sound "${input.sound}". Sounds: ${SOUND_LIBRARY.map((s) => s.id).join(", ")}`);
    const duration = cur.durationSec!;
    const grid = this.store.readArrangement(projectId, cur.rootTakeId).grid ?? this.beatGrid(root);
    const snap = (sec: number) => (input.snap ? Math.min(duration, snapToBeat(grid, sec)) : sec);

    let startSec = input.startSec === undefined || input.startSec === null ? (grid.firstBeatSec < duration - 1 ? grid.firstBeatSec : 0) : snap(finite(input.startSec, "start"));
    if (startSec < 0 && startSec >= -0.25) startSec = 0;
    if (startSec < 0 || startSec > duration - MIN_CLIP_SEC) invalid(`start ${round3(startSec)} s is outside the song (0–${duration} s)`);

    const render = { bpm: grid.bpm, key: cur.params.key, beatsPerBar: grid.beatsPerBar, sampleRate: cur.sampleRate! };
    const file = soundFileName(sound!, render);
    const target = this.store.soundPath(projectId, file)!;
    let fileDurationSec: number;
    if (existsSync(target)) {
      fileDurationSec = durationSeconds(decodeWav(readFileSync(target)));
    } else {
      const audio = renderSound(sound!.id, render);
      this.store.writeSound(projectId, file, encodeWav(audio));
      fileDurationSec = durationSeconds(audio);
    }

    let endSec = input.endSec === undefined || input.endSec === null ? (sound!.loop ? duration : startSec + fileDurationSec) : snap(finite(input.endSec, "end"));
    if (!sound!.loop) endSec = Math.min(endSec, startSec + fileDurationSec);
    endSec = Math.min(endSec, duration);
    if (endSec - startSec < MIN_CLIP_SEC) invalid(`the sound must end after it starts (got ${round3(startSec)}–${round3(endSec)} s)`);

    const a = this.store.readArrangement(projectId, cur.rootTakeId);
    if (a.clips.length >= MAX_CLIPS) invalid(`the timeline already has ${MAX_CLIPS} sounds; remove one first`);
    const track = this.placeOnTrack(a, input, sound!.instrument, startSec, endSec);
    const clip: Clip = {
      id: newId("c", 3),
      trackId: track.id,
      sound: sound!.id,
      name: sound!.name,
      instrument: sound!.instrument,
      file,
      fileDurationSec: round3(fileDurationSec),
      loop: sound!.loop,
      startSec: round3(startSec),
      durationSec: round3(endSec - startSec),
      gainDb: Studio.gain(input.gainDb, 0),
    };
    a.clips.push(clip);
    const timeline = this.saveArrangement(projectId, cur.rootTakeId, a, "sound_added", { clip: clip.id, sound: clip.sound, track: track.name, startSec: clip.startSec, endSec: round3(endSec) });
    return { clip: timeline.clips.find((c) => c.id === clip.id) ?? clip, timeline };
  }

  /** Put an audio file of the person's own on the timeline (16-bit PCM WAV; the web client converts other formats). */
  importSound(projectId: string, input: { name: string; wav: Buffer; startSec?: number; trackId?: string }): { clip: Clip; timeline: Timeline } {
    const { cur } = this.requireSong(projectId);
    const duration = cur.durationSec!;
    let audio: WavAudio;
    try {
      audio = decodeWav(input.wav);
    } catch (err) {
      if (err instanceof WavFormatError) invalid(`this file cannot be used: ${err.message}`);
      throw err;
    }
    const fileDurationSec = durationSeconds(audio);
    if (fileDurationSec < MIN_CLIP_SEC) invalid("the audio file is empty");
    if (fileDurationSec > MAX_IMPORT_SEC) invalid(`the audio file is ${Math.round(fileDurationSec)} s long; the limit is ${MAX_IMPORT_SEC} s`);
    const name = (input.name ?? "").replace(/\.[a-z0-9]{1,5}$/i, "").trim().slice(0, 60) || "Audio";
    const startSec = Math.min(Math.max(0, input.startSec === undefined ? 0 : finite(input.startSec, "start")), duration - MIN_CLIP_SEC);
    const endSec = Math.min(duration, startSec + fileDurationSec);

    const a = this.store.readArrangement(projectId, cur.rootTakeId);
    if (a.clips.length >= MAX_CLIPS) invalid(`the timeline already has ${MAX_CLIPS} sounds; remove one first`);
    const file = `${slugify(name)}-${newId("f", 3).slice(2)}.wav`;
    this.store.writeSound(projectId, file, input.wav);
    const track = this.placeOnTrack(a, { trackId: input.trackId }, "audio", startSec, endSec);
    const clip: Clip = {
      id: newId("c", 3),
      trackId: track.id,
      sound: "import",
      name,
      instrument: "audio",
      file,
      fileDurationSec: round3(fileDurationSec),
      loop: false,
      startSec: round3(startSec),
      durationSec: round3(endSec - startSec),
      gainDb: 0,
    };
    a.clips.push(clip);
    const timeline = this.saveArrangement(projectId, cur.rootTakeId, a, "sound_imported", { clip: clip.id, file: `sounds/${file}`, track: track.name, startSec: clip.startSec });
    return { clip, timeline };
  }

  /** Move, resize, re-track or change the volume of a clip. */
  updateClip(projectId: string, clipId: string, patch: ClipPatch): { clip: Clip; timeline: Timeline } {
    const { cur, root } = this.requireSong(projectId);
    const duration = cur.durationSec!;
    const a = this.store.readArrangement(projectId, cur.rootTakeId);
    const clip = a.clips.find((c) => c.id === clipId);
    if (!clip) throw new StudioError("not_found", `there is no sound ${clipId} on the timeline`);
    const grid = this.store.readArrangement(projectId, cur.rootTakeId).grid ?? this.beatGrid(root);
    const snap = (sec: number) => (patch.snap ? Math.min(duration, snapToBeat(grid, sec)) : sec);
    const given = (v: unknown) => v !== undefined && v !== null;

    let length = Math.min(clip.durationSec, duration - clip.startSec);
    let startSec = clip.startSec;
    if (given(patch.startSec)) startSec = Math.max(0, snap(finite(patch.startSec, "start")));
    if (given(patch.endSec)) length = snap(finite(patch.endSec, "end")) - startSec;
    else if (given(patch.durationSec)) length = finite(patch.durationSec, "duration");
    if (!clip.loop) length = Math.min(length, clip.fileDurationSec);
    if (length < MIN_CLIP_SEC) invalid("the sound must end after it starts");
    // A resize is cut at the end of the song; a plain move keeps the length and stops at the end.
    if (given(patch.endSec) || given(patch.durationSec)) length = Math.min(length, duration - startSec);
    else startSec = Math.min(startSec, duration - length);
    if (startSec < 0 || length < MIN_CLIP_SEC) invalid(`that does not fit inside the song (0–${duration} s)`);
    clip.startSec = round3(startSec);
    clip.durationSec = round3(length);
    clip.gainDb = Studio.gain(patch.gainDb, clip.gainDb);
    if (patch.newTrack || (given(patch.trackId) && patch.trackId !== clip.trackId)) {
      clip.trackId = this.placeOnTrack(a, { trackId: patch.trackId, newTrack: patch.newTrack }, clip.instrument, clip.startSec, clip.startSec + clip.durationSec).id;
    }
    const timeline = this.saveArrangement(projectId, cur.rootTakeId, a, "sound_changed", {
      clip: clip.id,
      startSec: clip.startSec,
      endSec: round3(clip.startSec + clip.durationSec),
      gainDb: clip.gainDb,
    });
    return { clip: timeline.clips.find((c) => c.id === clip.id) ?? clip, timeline };
  }

  removeClip(projectId: string, clipId: string): Timeline {
    const { cur } = this.requireSong(projectId);
    const a = this.store.readArrangement(projectId, cur.rootTakeId);
    const clip = a.clips.find((c) => c.id === clipId);
    if (!clip) throw new StudioError("not_found", `there is no sound ${clipId} on the timeline`);
    a.clips = a.clips.filter((c) => c.id !== clipId);
    // The file stays in sounds/: another clip may use it, and an imported file is the person's own.
    return this.saveArrangement(projectId, cur.rootTakeId, a, "sound_removed", { clip: clipId, sound: clip.sound });
  }

  updateTrack(projectId: string, trackId: string, patch: { name?: string; muted?: boolean; gainDb?: number }): Timeline {
    const { cur } = this.requireSong(projectId);
    const a = this.store.readArrangement(projectId, cur.rootTakeId);
    const track = a.tracks.find((t) => t.id === trackId);
    if (!track) throw new StudioError("not_found", `there is no track ${trackId}`);
    if (patch.name !== undefined && patch.name !== null) track.name = text(patch.name, "track name", 40);
    if (typeof patch.muted === "boolean") track.muted = patch.muted;
    track.gainDb = Studio.gain(patch.gainDb, track.gainDb);
    return this.saveArrangement(projectId, cur.rootTakeId, a, "track_changed", { track: track.id, name: track.name, muted: track.muted, gainDb: track.gainDb });
  }

  /** A take with the song's sounds mixed in (the take itself is never changed). */
  mix(projectId: string, takeId: string): MixResult & { take: Take } {
    const take = this.take(projectId, takeId);
    const file = take.status === "done" ? this.store.takeAudioPath(take.id) : null;
    if (!file) invalid(`take ${takeId} is ${take.status}; only a finished take can be mixed`);
    const a = this.store.readArrangement(projectId, take.rootTakeId);
    const result = renderMix(decodeWav(readFileSync(file!)), a.tracks, a.clips, (name) => {
      try {
        return decodeWav(readFileSync(this.store.soundPath(projectId, name)!));
      } catch {
        return null;
      }
    });
    return { ...result, take };
  }

  // --- jobs -------------------------------------------------------------------------

  private async requireModelServer(): Promise<void> {
    // While the worker is mid-job the model server is known to be up (and may be too busy paging to answer quickly).
    if (this.queue.isBusy() && Date.now() - this.queue.lastContactAt < 60_000) return;
    const h = await this.ace.health(4000);
    if (!h.ok) {
      throw new StudioError(
        "model_server_unreachable",
        `The music model server is not reachable at ${this.config.acestepUrl}. Nothing was started. ` +
          `It has to be started on the machine first (scripts/start-model-server.sh; it takes about 80 seconds to come up).`,
      );
    }
  }

  private enqueue(take: Take): { job: Job; take: Take; queuePosition: number } {
    const job = this.store.insertJob({ projectId: take.projectId, takeId: take.id, kind: take.kind });
    this.store.setTakeJob(take.id, job.id);
    this.store.updateProject(take.projectId, {});
    const queuePosition = this.store.listJobsByStatus(["queued", "running"]).length;
    this.bus.emit(take.projectId, { type: "job", job });
    this.bus.emit(take.projectId, { type: "state" });
    const queued = this.store.getTake(take.id)!;
    this.queue.kick();
    return { job, take: queued, queuePosition };
  }

  /** Start a brand-new song: a take with no parent. Returns as soon as the job is queued. */
  async startGenerate(projectId: string, input: GenerateInput): Promise<{ job: Job; take: Take; queuePosition: number }> {
    const project = this.project(projectId);
    const title = text(input.title, "title", 120);
    const stylePrompt = text(input.stylePrompt, "style prompt", 1000);
    const lyrics = text(input.lyrics, "lyrics", 6000);
    const bpm = Math.round(finite(input.bpm, "bpm"));
    if (bpm < 40 || bpm > 220) invalid(`bpm must be between 40 and 220 (got ${bpm})`);
    const key = text(input.key, "key", 30);
    const durationSec = Math.round(finite(input.durationSec, "duration"));
    if (durationSec > this.config.maxDurationSec) {
      invalid(`duration ${durationSec} s is over the current limit of ${this.config.maxDurationSec} s; use ${this.config.maxDurationSec} or less`);
    }
    if (durationSec < MIN_DURATION_SEC) invalid(`duration must be at least ${MIN_DURATION_SEC} s (got ${durationSec})`);
    const timeSignature = String(input.timeSignature ?? "4").trim();
    if (!TIME_SIGNATURES.has(timeSignature)) invalid(`time signature must be one of 2, 3, 4, 6 (beats per bar); got "${timeSignature}"`);
    const vocalLanguage = (input.vocalLanguage ?? "en").trim().toLowerCase() || "en";
    const words = countSungWords(lyrics);
    const budget = wordBudget(durationSec, bpm, timeSignature);
    if (words > budget) {
      const needed = durationForWords(words, bpm, timeSignature);
      invalid(
        `the lyrics have ${words} sung words, but a ${durationSec} s song at ${bpm} bpm has room for about ${budget} (roughly ${Math.max(1, Math.round(budget / 8))} lines of 8 words). ` +
          `With more than that the model rushes and the words become unclear. Cut lines` +
          (needed <= this.config.maxDurationSec ? `, or make the song at least ${needed} s long` : "") +
          `.`,
      );
    }
    await this.requireModelServer();

    const params: TakeParams = {
      title,
      stylePrompt,
      lyrics,
      bpm,
      key,
      timeSignature,
      vocalLanguage,
      durationSec,
      seed: input.seed !== undefined ? Math.trunc(finite(input.seed, "seed")) : newSeed(),
      repaint: null,
    };
    const take = this.store.insertTake({
      projectId,
      parentTakeId: null,
      rootTakeId: null,
      kind: "generate",
      params,
      changeSummary: input.changeSummary?.trim() || `New song: ${title}`,
    });
    if (project.title === "Untitled song") this.store.updateProject(projectId, { title });
    return this.enqueue(take);
  }

  /** Regenerate one time range of a finished take. Creates a child take; the parent is never touched. */
  async startRepaint(projectId: string, input: RepaintInput): Promise<{ job: Job; take: Take; queuePosition: number }> {
    const parent = this.take(projectId, text(input.takeId, "take id", 40));
    if (parent.status !== "done" || !parent.durationSec) {
      invalid(`take ${parent.id} is ${parent.status}; only a finished take can be repainted`);
    }
    const duration = parent.durationSec!;
    let startSec = finite(input.startSec, "start");
    let endSec = finite(input.endSec, "end");
    if (endSec > duration && endSec <= duration + 0.25) endSec = duration;
    if (startSec < 0 && startSec >= -0.25) startSec = 0;
    if (startSec < 0 || endSec > duration) invalid(`the range ${startSec}–${endSec} s is outside the song (0–${duration} s)`);
    if (endSec - startSec < MIN_REPAINT_SEC) invalid(`the range must be at least ${MIN_REPAINT_SEC} s long (got ${round3(endSec - startSec)} s)`);
    const lyrics = text(input.lyrics, "lyrics", 6000);
    // A repaint may not add words to a song that is already full. Takes made before
    // the budget existed can be over it, so the parent's own count is allowed too.
    const words = countSungWords(lyrics);
    const budget = Math.max(wordBudget(duration, parent.params.bpm, parent.params.timeSignature), countSungWords(parent.params.lyrics));
    if (words > budget) {
      invalid(
        `the lyrics would have ${words} sung words, but this ${Math.round(duration)} s song has room for about ${budget}. ` +
          `With more than that the model rushes and the words become unclear. Keep the new part about as long as the lines it replaces.`,
      );
    }
    const stylePrompt = input.stylePrompt?.trim() ? text(input.stylePrompt, "style prompt", 1000) : parent.params.stylePrompt;
    await this.requireModelServer();

    startSec = round3(startSec);
    endSec = round3(endSec);
    const params: TakeParams = {
      ...parent.params,
      stylePrompt,
      lyrics,
      durationSec: duration,
      seed: input.seed !== undefined ? Math.trunc(finite(input.seed, "seed")) : newSeed(),
      repaint: { startSec, endSec },
      joins: this.joinOptions(input.joins),
    };
    const take = this.store.insertTake({
      projectId,
      parentTakeId: parent.id,
      rootTakeId: parent.rootTakeId,
      kind: "repaint",
      params,
      changeSummary: input.changeSummary?.trim() || `Repainted ${startSec.toFixed(1)}–${endSec.toFixed(1)} s`,
    });
    return this.enqueue(take);
  }
}
