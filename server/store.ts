// Project storage as plain files. A project is a folder; there is no database.
//
//   <projectsDir>/<project-id>/
//     song.json            title, current take, section markers, and a read-only
//                          summary of the current take's parameters
//     lyrics.md            the current take's lyrics (yours to edit, see below)
//     takes/take-001.json  everything that made take 1 (immutable once finished)
//     takes/take-001.wav   its audio, plus take-001.peaks.json for the waveform
//     timeline.json        sounds layered on the song: tracks and clips (per song)
//     sounds/*.wav         the audio of those clips (rendered library sounds, imported files)
//     history.jsonl        append-only log of what happened, one JSON object per line
//     chat.jsonl           the conversation, one message per line (append-only)
//     .studio/             app state that does not belong in git: jobs, selection
//     .gitignore           ignores .studio/
//
// The folder is the source of truth: nothing is cached across calls, so a
// change made in a text editor or by another program is seen on the next read.
// Files the app rewrites are replaced atomically (write to a temp file, rename).
//
// lyrics.md is a working copy. When the current take changes, the app rewrites
// it only if it still holds the previous current take's lyrics; lyrics you
// edited by hand are never overwritten. Until a take is made from them, the
// project reports them as a draft (see lyricsDraft()).

import { randomBytes } from "node:crypto";
import { appendFileSync, existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";
import type {
  BeatGrid,
  ChordRegion,
  ChatContent,
  ChatMessage,
  Clip,
  Job,
  JobStatus,
  JobTimings,
  Marker,
  Project,
  ProjectSummary,
  Selection,
  SpliceChecks,
  Take,
  TakeParams,
  TakeStatus,
  TakeTiming,
  Track,
} from "./types.ts";

export const SONG_FORMAT = "song-studio/1";
export const TIMELINE_FORMAT = "song-studio/timeline/1";
/** Names the app accepts for files in sounds/: no folders, no dot files, WAV only. */
const SOUND_FILE = /^[a-z0-9][a-z0-9._-]{0,119}\.wav$/;

/** The tracks and clips of one song (the lineage of a first take). */
export interface Arrangement {
  chords?: ChordRegion[];
  grid?: BeatGrid;
  tracks: Track[];
  clips: Clip[];
}
const PROJECT_ID = /^[a-z0-9][a-z0-9._-]{0,99}$/;

export function newId(prefix: string, bytes = 4): string {
  return `${prefix}_${randomBytes(bytes).toString("hex")}`;
}

export function slugify(title: string): string {
  const s = title
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40)
    .replace(/-+$/g, "");
  return s || "song";
}

function readJson<T>(file: string): T | null {
  let text: string;
  try {
    text = readFileSync(file, "utf8");
  } catch {
    return null;
  }
  try {
    return JSON.parse(text) as T;
  } catch {
    // A hand-edited file with a syntax error: treat it as unreadable rather than crash.
    console.warn(`[store] ${file} is not valid JSON; ignoring it`);
    return null;
  }
}

function writeAtomic(file: string, text: string): void {
  mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.${randomBytes(3).toString("hex")}.tmp`;
  writeFileSync(tmp, text);
  renameSync(tmp, file);
}

function writeJson(file: string, value: unknown): void {
  writeAtomic(file, JSON.stringify(value, null, 2) + "\n");
}

function readLines(file: string): any[] {
  let text: string;
  try {
    text = readFileSync(file, "utf8");
  } catch {
    return [];
  }
  const out: any[] = [];
  for (const line of text.split("\n")) {
    if (!line.trim()) continue;
    try {
      out.push(JSON.parse(line));
    } catch {
      console.warn(`[store] skipping a line of ${file} that is not valid JSON`);
    }
  }
  return out;
}

function sameText(a: string | null, b: string | null): boolean {
  if (a === null || b === null) return a === b;
  return a.replace(/\s+$/, "") === b.replace(/\s+$/, "");
}

/** What song.json holds. Fields the app reads back are marked; the rest is a summary for people and tools. */
interface SongFile {
  format: string;
  /** read back */
  title: string;
  createdAt: string;
  updatedAt: string;
  /** read back: the id of the current take, or null */
  currentTake: string | null;
  /** summary of the current take (ignored when read) */
  current: null | {
    take: number;
    audio: string;
    stylePrompt: string;
    bpm: number;
    key: string;
    timeSignature: string;
    vocalLanguage: string;
    durationSec: number | null;
  };
  /** read back: named time ranges, per song (keyed by the id of the song's first take) */
  sections: Record<string, Marker[]>;
}

/** On disk a take is its Take record without the project id (that is the folder) plus its audio file name. */
type TakeFile = Omit<Take, "projectId"> & { audio: string | null };

interface StateFile {
  selection: Selection | null;
}

export interface StoredMessage {
  message: ChatMessage;
  /** Provider-facing payload saved with the message (see agent/loop.ts). */
  llm: unknown;
}

export interface HistoryEntry {
  at: string;
  event: string;
  [k: string]: unknown;
}

export class ProjectStore {
  readonly root: string;
  /** id -> project id, filled lazily; a miss triggers one rescan. */
  private readonly takeIndex = new Map<string, string>();
  private readonly jobIndex = new Map<string, string>();

  constructor(root: string) {
    this.root = path.resolve(root);
    mkdirSync(this.root, { recursive: true });
  }

  close(): void {}

  /** Kept for call sites written against a database. Node runs this synchronously, so nothing interleaves. */
  tx<T>(fn: () => T): T {
    return fn();
  }

  // --- paths --------------------------------------------------------------------------

  projectDir(id: string): string {
    if (!PROJECT_ID.test(id)) throw new Error(`invalid project id ${JSON.stringify(id)}`);
    return path.join(this.root, id);
  }

  private songFile(id: string): string {
    return path.join(this.projectDir(id), "song.json");
  }

  private takesDir(id: string): string {
    return path.join(this.projectDir(id), "takes");
  }

  private jobsDir(id: string): string {
    return path.join(this.projectDir(id), ".studio", "jobs");
  }

  lyricsFile(id: string): string {
    return path.join(this.projectDir(id), "lyrics.md");
  }

  /** Base name of a take's files: take-001 */
  static takeStem(seq: number): string {
    return `take-${String(seq).padStart(3, "0")}`;
  }

  /** Absolute path of one of a take's files, e.g. takePath(t, ".wav"), takePath(t, ".peaks.json"). */
  takePath(take: Pick<Take, "projectId" | "seq">, suffix: string): string {
    return path.join(this.takesDir(take.projectId), ProjectStore.takeStem(take.seq) + suffix);
  }

  /** Absolute path of a finished take's audio, or null. */
  takeAudioPath(takeId: string): string | null {
    const t = this.getTake(takeId);
    if (!t) return null;
    const f = readJson<TakeFile>(this.takePath(t, ".json"));
    return f?.audio ? path.join(this.takesDir(t.projectId), f.audio) : null;
  }

  private isProject(id: string): boolean {
    return PROJECT_ID.test(id) && existsSync(this.songFile(id));
  }

  private projectIds(): string[] {
    let names: string[];
    try {
      names = readdirSync(this.root);
    } catch {
      return [];
    }
    return names.filter((n) => this.isProject(n));
  }

  // --- history log -----------------------------------------------------------------------

  log(projectId: string, event: string, details: Record<string, unknown> = {}): void {
    const entry: HistoryEntry = { at: new Date().toISOString(), event, ...details };
    appendFileSync(path.join(this.projectDir(projectId), "history.jsonl"), JSON.stringify(entry) + "\n");
  }

  history(projectId: string): HistoryEntry[] {
    return readLines(path.join(this.projectDir(projectId), "history.jsonl"));
  }

  // --- projects --------------------------------------------------------------------------

  private readSong(id: string): SongFile | null {
    const s = readJson<Partial<SongFile>>(this.songFile(id));
    if (!s) return null;
    return {
      format: s.format ?? SONG_FORMAT,
      title: typeof s.title === "string" && s.title.trim() ? s.title.trim() : id,
      createdAt: s.createdAt ?? new Date(0).toISOString(),
      updatedAt: s.updatedAt ?? s.createdAt ?? new Date(0).toISOString(),
      currentTake: typeof s.currentTake === "string" ? s.currentTake : null,
      current: s.current ?? null,
      sections: s.sections && typeof s.sections === "object" ? s.sections : {},
    };
  }

  private writeSong(id: string, song: SongFile): void {
    const cur = song.currentTake ? this.getTake(song.currentTake) : null;
    song.current =
      cur && cur.projectId === id
        ? {
            take: cur.seq,
            audio: `takes/${ProjectStore.takeStem(cur.seq)}.wav`,
            stylePrompt: cur.params.stylePrompt,
            bpm: cur.params.bpm,
            key: cur.params.key,
            timeSignature: cur.params.timeSignature,
            vocalLanguage: cur.params.vocalLanguage,
            durationSec: cur.durationSec,
          }
        : null;
    writeJson(this.songFile(id), {
      format: SONG_FORMAT,
      title: song.title,
      createdAt: song.createdAt,
      updatedAt: song.updatedAt,
      currentTake: song.currentTake,
      current: song.current,
      sections: song.sections,
    });
  }

  private readState(id: string): StateFile {
    return readJson<StateFile>(path.join(this.projectDir(id), ".studio", "state.json")) ?? { selection: null };
  }

  createProject(title: string): Project {
    const base = slugify(title === "Untitled song" ? "untitled" : title);
    let id = "";
    for (let i = 0; i < 20; i++) {
      id = `${base}-${randomBytes(2).toString("hex")}`;
      if (!existsSync(path.join(this.root, id))) break;
    }
    const dir = this.projectDir(id);
    mkdirSync(path.join(dir, "takes"), { recursive: true });
    mkdirSync(path.join(dir, ".studio", "jobs"), { recursive: true });
    writeAtomic(path.join(dir, ".gitignore"), "# App state (jobs in progress, your current selection). Not part of the song.\n.studio/\n");
    const now = new Date().toISOString();
    this.writeSong(id, { format: SONG_FORMAT, title, createdAt: now, updatedAt: now, currentTake: null, current: null, sections: {} });
    this.log(id, "project_created", { title });
    return this.getProject(id)!;
  }

  getProject(id: string): Project | null {
    if (!this.isProject(id)) return null;
    const s = this.readSong(id);
    if (!s) return null;
    return {
      id,
      title: s.title,
      path: this.projectDir(id),
      currentTakeId: s.currentTake,
      selection: this.readState(id).selection ?? null,
      createdAt: Date.parse(s.createdAt) || 0,
      updatedAt: Date.parse(s.updatedAt) || 0,
    };
  }

  listProjects(): ProjectSummary[] {
    const out: ProjectSummary[] = [];
    for (const id of this.projectIds()) {
      const p = this.getProject(id);
      if (!p) continue;
      const takes = this.listTakes(id);
      out.push({
        ...p,
        takeCount: takes.filter((t) => t.status === "done").length,
        currentTakeTitle: takes.find((t) => t.id === p.currentTakeId)?.params.title ?? null,
      });
    }
    return out.sort((a, b) => b.updatedAt - a.updatedAt);
  }

  updateProject(id: string, patch: { title?: string; currentTakeId?: string | null; selection?: Selection | null }): void {
    const song = this.readSong(id);
    if (!song) throw new Error(`project ${id} does not exist`);
    if (patch.selection !== undefined) {
      writeJson(path.join(this.projectDir(id), ".studio", "state.json"), { ...this.readState(id), selection: patch.selection });
    }
    const before = song.currentTake;
    if (patch.title !== undefined) song.title = patch.title;
    if (patch.currentTakeId !== undefined) song.currentTake = patch.currentTakeId;
    song.updatedAt = new Date().toISOString();
    this.writeSong(id, song);
    if (patch.currentTakeId !== undefined && patch.currentTakeId !== before) this.syncLyrics(id, before, patch.currentTakeId);
  }

  /** Point lyrics.md at the new current take, unless it holds edits that no take has yet. */
  private syncLyrics(id: string, fromTakeId: string | null, toTakeId: string | null): void {
    const to = toTakeId ? this.getTake(toTakeId) : null;
    if (!to) return;
    const file = this.lyricsFile(id);
    const onDisk = existsSync(file) ? readFileSync(file, "utf8") : null;
    const from = fromTakeId ? this.getTake(fromTakeId) : null;
    if (onDisk === null || sameText(onDisk, from?.params.lyrics ?? null) || sameText(onDisk, to.params.lyrics) || !onDisk.trim()) {
      if (!sameText(onDisk, to.params.lyrics)) writeAtomic(file, to.params.lyrics.replace(/\s+$/, "") + "\n");
    } else {
      this.log(id, "lyrics_kept", { note: "lyrics.md has edits that are not in any take, so it was not overwritten", currentTake: to.id });
    }
  }

  /** The text of lyrics.md when it differs from the current take's lyrics (hand edits not sung yet), else null. */
  lyricsDraft(id: string): string | null {
    const file = this.lyricsFile(id);
    if (!existsSync(file)) return null;
    const text = readFileSync(file, "utf8");
    const p = this.getProject(id);
    const cur = p?.currentTakeId ? this.getTake(p.currentTakeId) : null;
    if (!cur || !text.trim() || sameText(text, cur.params.lyrics)) return null;
    return text.replace(/\s+$/, "");
  }

  /** Deletes the project folder and everything in it. */
  deleteProject(id: string): void {
    for (const [k, v] of this.takeIndex) if (v === id) this.takeIndex.delete(k);
    for (const [k, v] of this.jobIndex) if (v === id) this.jobIndex.delete(k);
    rmSync(this.projectDir(id), { recursive: true, force: true });
  }

  // --- takes -------------------------------------------------------------------------------

  private readTakeFile(projectId: string, file: string): Take | null {
    const f = readJson<TakeFile>(path.join(this.takesDir(projectId), file));
    if (!f || typeof f.id !== "string") return null;
    const { audio: _audio, ...rest } = f;
    this.takeIndex.set(f.id, projectId);
    return { ...rest, projectId };
  }

  private writeTake(take: Take, audio: string | null): void {
    const { projectId: _p, ...rest } = take;
    const record: TakeFile = { ...rest, audio };
    writeJson(this.takePath(take, ".json"), record);
    this.takeIndex.set(take.id, take.projectId);
  }

  private takeAudioName(take: Take): string | null {
    return readJson<TakeFile>(this.takePath(take, ".json"))?.audio ?? null;
  }

  insertTake(t: {
    projectId: string;
    parentTakeId: string | null;
    rootTakeId: string | null;
    kind: Take["kind"];
    params: TakeParams;
    changeSummary: string;
  }): Take {
    const seq = this.listTakes(t.projectId).reduce((m, x) => Math.max(m, x.seq), 0) + 1;
    const id = newId("t", 3);
    const take: Take = {
      id,
      projectId: t.projectId,
      seq,
      parentTakeId: t.parentTakeId,
      rootTakeId: t.rootTakeId ?? id,
      kind: t.kind,
      status: "queued",
      params: t.params,
      changeSummary: t.changeSummary,
      durationSec: null,
      sampleRate: null,
      checks: null,
      error: null,
      jobId: null,
      createdAt: Date.now(),
      finishedAt: null,
    };
    this.writeTake(take, null);
    this.log(t.projectId, "take_queued", { take: id, number: seq, kind: t.kind, parent: t.parentTakeId, summary: t.changeSummary });
    return take;
  }

  getTake(id: string): Take | null {
    let projectId = this.takeIndex.get(id);
    if (projectId) {
      const t = this.findTakeIn(projectId, id);
      if (t) return t;
    }
    // Unknown or moved: rescan every project once.
    for (const pid of this.projectIds()) {
      const t = this.findTakeIn(pid, id);
      if (t) return t;
    }
    this.takeIndex.delete(id);
    return null;
  }

  private findTakeIn(projectId: string, id: string): Take | null {
    if (!this.isProject(projectId)) return null;
    return this.listTakes(projectId).find((t) => t.id === id) ?? null;
  }

  listTakes(projectId: string): Take[] {
    let files: string[];
    try {
      files = readdirSync(this.takesDir(projectId)).filter((f) => /^take-\d+\.json$/.test(f));
    } catch {
      return [];
    }
    return files
      .map((f) => this.readTakeFile(projectId, f))
      .filter((t): t is Take => t !== null)
      .sort((a, b) => a.seq - b.seq);
  }

  private patchTake(id: string, fn: (t: Take) => void, audio?: string | null): Take {
    const t = this.getTake(id);
    if (!t) throw new Error(`take ${id} does not exist`);
    const keepAudio = audio === undefined ? this.takeAudioName(t) : audio;
    fn(t);
    this.writeTake(t, keepAudio);
    return t;
  }

  setTakeJob(id: string, jobId: string): void {
    this.patchTake(id, (t) => {
      t.jobId = jobId;
    });
  }

  setTakeStatus(id: string, status: TakeStatus, error: string | null = null): void {
    const t = this.patchTake(id, (t) => {
      t.status = status;
      t.error = error;
      if (status === "done" || status === "failed") t.finishedAt = Date.now();
    });
    if (status === "failed") this.log(t.projectId, "take_failed", { take: id, number: t.seq, error });
  }

  /** The one and only write of a take's audio facts; after this the take never changes. */
  finaliseTake(id: string, f: { audioFile: string; durationSec: number; sampleRate: number; checks: SpliceChecks | null }): void {
    const before = this.getTake(id);
    if (!before || (before.status !== "queued" && before.status !== "running")) return;
    const t = this.patchTake(
      id,
      (t) => {
        t.status = "done";
        t.error = null;
        t.durationSec = f.durationSec;
        t.sampleRate = f.sampleRate;
        t.checks = f.checks;
        t.finishedAt = Date.now();
      },
      f.audioFile,
    );
    this.log(t.projectId, "take_ready", {
      take: id,
      number: t.seq,
      audio: `takes/${f.audioFile}`,
      durationSec: f.durationSec,
      ...(f.checks ? { splice: f.checks.status, bitIdenticalOutside: f.checks.bitIdenticalOutside } : {}),
    });
  }

  // --- timing (derived from the audio after a take is finished) -----------------------------------

  readTiming(take: Pick<Take, "projectId" | "seq">): TakeTiming | null {
    return readJson<TakeTiming>(this.takePath(take, ".timing.json"));
  }

  writeTiming(take: Pick<Take, "projectId" | "seq">, timing: TakeTiming): void {
    writeJson(this.takePath(take, ".timing.json"), timing);
  }

  // --- beat grid (derived from the audio, like timing) ---------------------------------------------

  readBeats(take: Pick<Take, "projectId" | "seq">): BeatGrid | null {
    const g = readJson<BeatGrid>(this.takePath(take, ".beats.json"));
    return g && Number.isFinite(g.bpm) && g.bpm > 0 && Number.isFinite(g.beatSec) && g.beatSec > 0 && Number.isFinite(g.firstBeatSec) ? g : null;
  }

  writeBeats(take: Pick<Take, "projectId" | "seq">, grid: BeatGrid): void {
    writeJson(this.takePath(take, ".beats.json"), grid);
  }

  // --- timeline (timeline.json) and its audio (sounds/) ---------------------------------------------

  private timelineFile(id: string): string {
    return path.join(this.projectDir(id), "timeline.json");
  }

  /** Absolute path of a file in the project's sounds/ folder, or null if the name is not one the app accepts. */
  soundPath(projectId: string, file: string): string | null {
    return SOUND_FILE.test(file) ? path.join(this.projectDir(projectId), "sounds", file) : null;
  }

  writeSound(projectId: string, file: string, wav: Buffer): void {
    const target = this.soundPath(projectId, file);
    if (!target) throw new Error(`invalid sound file name ${JSON.stringify(file)}`);
    mkdirSync(path.dirname(target), { recursive: true });
    const tmp = `${target}.${process.pid}.${randomBytes(3).toString("hex")}.tmp`;
    writeFileSync(tmp, wav);
    renameSync(tmp, target);
  }

  /** The song's tracks and clips. Entries that a hand edit left unusable are dropped, not fatal. */
  readArrangement(projectId: string, rootTakeId: string): Arrangement {
    const song = readJson<{ songs?: Record<string, Partial<Arrangement>> }>(this.timelineFile(projectId))?.songs?.[rootTakeId];
    const num = (v: unknown) => typeof v === "number" && Number.isFinite(v);
    const tracks = (Array.isArray(song?.tracks) ? song.tracks : [])
      .filter((t) => t && typeof t.id === "string" && typeof t.name === "string")
      .map((t) => ({ id: t.id, name: t.name, muted: t.muted === true, gainDb: num(t.gainDb) ? t.gainDb : 0 }));
    const clips = (Array.isArray(song?.clips) ? song.clips : [])
      .filter(
        (c) =>
          c &&
          typeof c.id === "string" &&
          tracks.some((t) => t.id === c.trackId) &&
          typeof c.file === "string" &&
          SOUND_FILE.test(c.file) &&
          num(c.startSec) &&
          num(c.durationSec) &&
          c.durationSec > 0 &&
          num(c.fileDurationSec) &&
          c.fileDurationSec > 0,
      )
      .map((c) => ({
        id: c.id,
        trackId: c.trackId,
        sound: typeof c.sound === "string" ? c.sound : "import",
        name: typeof c.name === "string" ? c.name : c.file,
        instrument: typeof c.instrument === "string" ? c.instrument : "audio",
        file: c.file,
        fileDurationSec: c.fileDurationSec,
        loop: c.loop === true,
        startSec: Math.max(0, c.startSec),
        durationSec: c.durationSec,
        gainDb: num(c.gainDb) ? c.gainDb : 0,
      }));
    return { tracks, clips, chords: Array.isArray(song?.chords) ? song.chords : [], grid: song?.grid };
  }

  arrangementHistory(projectId: string, rootTakeId: string): { past: Arrangement[]; future: Arrangement[] } {
    const song = readJson<{ songs?: Record<string, { history?: { past: Arrangement[]; future: Arrangement[] } }> }>(this.timelineFile(projectId))?.songs?.[rootTakeId];
    return song?.history ?? { past: [], future: [] };
  }

  writeArrangement(projectId: string, rootTakeId: string, arrangement: Arrangement, direction?: "undo" | "redo"): void {
    const current = this.readArrangement(projectId, rootTakeId);
    const history = this.arrangementHistory(projectId, rootTakeId);
    if (direction === "undo") { history.past.pop(); history.future.push(current); }
    else if (direction === "redo") { history.future.pop(); history.past.push(current); }
    else {
      if (JSON.stringify(current) === JSON.stringify(arrangement)) return;
      history.past.push(current);
      history.past = history.past.slice(-100);
      history.future = [];
    }
    const file = readJson<{ songs?: Record<string, unknown> }>(this.timelineFile(projectId));
    const songs = file?.songs && typeof file.songs === "object" ? file.songs : {};
    songs[rootTakeId] = { ...arrangement, history };
    writeJson(this.timelineFile(projectId), { format: TIMELINE_FORMAT, songs });
  }

  saveLyricsDraft(projectId: string, lyrics: string): void {
    writeAtomic(path.join(this.projectDir(projectId), "lyrics.md"), lyrics);
  }

  // --- jobs ----------------------------------------------------------------------------------

  private jobFile(projectId: string, jobId: string): string {
    return path.join(this.jobsDir(projectId), `${jobId}.json`);
  }

  insertJob(j: { projectId: string; takeId: string; kind: Job["kind"] }): Job {
    const job: Job = {
      id: newId("j"),
      projectId: j.projectId,
      takeId: j.takeId,
      kind: j.kind,
      status: "queued",
      progress: 0,
      stage: null,
      progressText: null,
      error: null,
      timings: {},
      createdAt: Date.now(),
      startedAt: null,
      finishedAt: null,
    };
    writeJson(this.jobFile(j.projectId, job.id), { ...job, acestepTask: null });
    this.jobIndex.set(job.id, j.projectId);
    return job;
  }

  private readJob(projectId: string, jobId: string): (Job & { acestepTask?: string | null }) | null {
    const j = readJson<Job & { acestepTask?: string | null }>(this.jobFile(projectId, jobId));
    return j ? { ...j, projectId } : null;
  }

  getJob(id: string): Job | null {
    const known = this.jobIndex.get(id);
    const tryIn = (pid: string) => (this.isProject(pid) ? this.readJob(pid, id) : null);
    let j = known ? tryIn(known) : null;
    if (!j) {
      for (const pid of this.projectIds()) {
        j = tryIn(pid);
        if (j) {
          this.jobIndex.set(id, pid);
          break;
        }
      }
    }
    if (!j) return null;
    const { acestepTask: _t, ...job } = j;
    return job;
  }

  listJobsByStatus(statuses: JobStatus[], projectId?: string): Job[] {
    const out: Job[] = [];
    for (const pid of projectId ? [projectId] : this.projectIds()) {
      let files: string[];
      try {
        files = readdirSync(this.jobsDir(pid)).filter((f) => f.endsWith(".json"));
      } catch {
        continue;
      }
      for (const f of files) {
        const j = this.readJob(pid, f.slice(0, -5));
        if (j && statuses.includes(j.status)) {
          const { acestepTask: _t, ...job } = j;
          out.push(job);
          this.jobIndex.set(job.id, pid);
        }
      }
    }
    // Oldest first; ids break ties so the order is stable.
    return out.sort((a, b) => a.createdAt - b.createdAt || (a.id < b.id ? -1 : 1));
  }

  updateJob(
    id: string,
    patch: Partial<{
      status: JobStatus;
      progress: number;
      stage: string | null;
      progressText: string | null;
      acestepTask: string | null;
      error: string | null;
      timings: JobTimings;
      startedAt: number;
      finishedAt: number;
    }>,
  ): Job {
    const job = this.getJob(id);
    if (!job) throw new Error(`job ${id} does not exist`);
    const raw = this.readJob(job.projectId, id)!;
    for (const [k, v] of Object.entries(patch)) if (v !== undefined) (raw as any)[k] = v;
    const { projectId: _p, ...stored } = raw;
    writeJson(this.jobFile(job.projectId, id), stored);
    return this.getJob(id)!;
  }

  // --- markers (song.json "sections") ---------------------------------------------------------

  getMarkers(projectId: string, rootTakeId: string): Marker[] {
    const list = this.readSong(projectId)?.sections[rootTakeId];
    if (!Array.isArray(list)) return [];
    return list
      .filter((m) => m && typeof m.label === "string" && Number.isFinite(m.startSec) && Number.isFinite(m.endSec))
      .map((m) => ({ label: m.label, startSec: m.startSec, endSec: m.endSec }));
  }

  replaceMarkers(projectId: string, rootTakeId: string, markers: Marker[]): void {
    const song = this.readSong(projectId);
    if (!song) throw new Error(`project ${projectId} does not exist`);
    if (markers.length) song.sections[rootTakeId] = markers;
    else delete song.sections[rootTakeId];
    song.updatedAt = new Date().toISOString();
    this.writeSong(projectId, song);
    this.log(projectId, "sections_set", { song: rootTakeId, sections: markers });
  }

  // --- import (migration from the old database) -------------------------------------------------

  /** Create a project folder with a given id and timestamps. */
  importProject(id: string, p: { title: string; createdAt: number; updatedAt: number }): void {
    const dir = this.projectDir(id);
    mkdirSync(path.join(dir, "takes"), { recursive: true });
    mkdirSync(path.join(dir, ".studio", "jobs"), { recursive: true });
    writeAtomic(path.join(dir, ".gitignore"), "# App state (jobs in progress, your current selection). Not part of the song.\n.studio/\n");
    const iso = (ms: number) => new Date(ms).toISOString();
    this.writeSong(id, { format: SONG_FORMAT, title: p.title, createdAt: iso(p.createdAt), updatedAt: iso(p.updatedAt), currentTake: null, current: null, sections: {} });
  }

  /** Write a take record as-is (keeps its id and number). */
  importTake(take: Take, audioName: string | null): void {
    this.writeTake(take, audioName);
  }

  importMessage(projectId: string, m: { id: number; createdAt: number; content: ChatContent; llm: unknown }): void {
    const line = { id: m.id, createdAt: m.createdAt, ...m.content, ...(m.llm === null || m.llm === undefined ? {} : { llm: m.llm }) };
    appendFileSync(this.chatFile(projectId), JSON.stringify(line) + "\n");
  }

  // --- chat (chat.jsonl) ---------------------------------------------------------------------------

  private chatFile(projectId: string): string {
    return path.join(this.projectDir(projectId), "chat.jsonl");
  }

  insertMessage(projectId: string, content: ChatContent, llm: unknown = null): ChatMessage {
    const lines = readLines(this.chatFile(projectId));
    const id = lines.reduce((m, l) => Math.max(m, Number(l.id) || 0), 0) + 1;
    const now = Date.now();
    const line = { id, createdAt: now, ...content, ...(llm === null || llm === undefined ? {} : { llm }) };
    appendFileSync(this.chatFile(projectId), JSON.stringify(line) + "\n");
    return { ...content, id, projectId, createdAt: now };
  }

  listStoredMessages(projectId: string): StoredMessage[] {
    return readLines(this.chatFile(projectId)).map((l) => {
      const { llm, id, createdAt, ...content } = l;
      return { message: { ...(content as ChatContent), id, projectId, createdAt }, llm: llm ?? null };
    });
  }

  listMessages(projectId: string): ChatMessage[] {
    return this.listStoredMessages(projectId).map((s) => s.message);
  }

  /** Size and modification time of a file in the project, for change detection. */
  fileStamp(projectId: string, rel: string): string | null {
    try {
      const s = statSync(path.join(this.projectDir(projectId), rel));
      return `${s.size}:${s.mtimeMs}`;
    } catch {
      return null;
    }
  }
}
