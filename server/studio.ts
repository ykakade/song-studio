// The studio service: every operation the product offers, in one place.
// The agent's tools and the HTTP API both call these methods, so "what the
// LLM can do" and "what the API can do" are the same code path.

import { randomInt } from "node:crypto";
import { AceStepClient } from "./acestep.ts";
import type { Config } from "./config.ts";
import type { ProjectStore } from "./store.ts";
import type { EventBus } from "./events.ts";
import { countSungWords, durationForWords, wordBudget } from "./lyrics.ts";
import type { JobQueue } from "./queue.ts";
import type { Job, Marker, Project, ProjectSummary, Selection, Take, TakeParams, TakeTiming } from "./types.ts";

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
  takeId: string;
  startSec: number;
  endSec: number;
  /** The complete lyrics of the song after the change. */
  lyrics: string;
  stylePrompt?: string;
  seed?: number;
  changeSummary?: string;
}

export const MIN_DURATION_SEC = 10;
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
