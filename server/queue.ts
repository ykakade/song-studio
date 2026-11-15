// The job queue: one worker, strictly serial.
//
// The model server needs more memory than this machine has, so two jobs at once
// would grind it to a halt. Everything that reaches ACE-Step goes through here.
//
// Restart behaviour: a job that was `running` when the server stopped is marked
// failed on the next start (we cannot know what the model server did with it);
// jobs that were still `queued` were never submitted, so they simply run.

import { mkdirSync } from "node:fs";
import { readdir, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { AceStepClient, AceStepError } from "./acestep.ts";
import type { Config } from "./config.ts";
import type { ProjectStore } from "./store.ts";
import type { EventBus } from "./events.ts";
import { alignLyrics } from "./align.ts";
import { compareOutside, spliceRepaint } from "./splice.ts";
import type { Transcriber } from "./transcribe.ts";
import type { Job, JobTimings, SpliceChecks, Take } from "./types.ts";
import { computePeaks, durationSeconds, readWavFile, writeWavFile, type WavAudio } from "./wav.ts";

const PEAK_POINTS = 2400;

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

export function describeChecks(c: SpliceChecks): string {
  if (c.status === "verified") {
    const gain = c.gainDb === null ? "gain not estimated" : `model gain ${c.gainDb >= 0 ? "+" : ""}${c.gainDb.toFixed(2)} dB undone`;
    return `Verified: everything outside ${c.startSec.toFixed(2)}–${c.endSec.toFixed(2)} s is bit-identical to the parent take (${gain}).`;
  }
  if (c.status === "fallback") return `NOT verified: the model's file was used as-is (${c.reason}).`;
  return `Splice check FAILED: ${c.reason}.`;
}

export class JobQueue {
  private readonly store: ProjectStore;
  private readonly ace: AceStepClient;
  private readonly bus: EventBus;
  private readonly config: Config;
  readonly tmpDir: string;
  private working = false;
  private stopped = false;
  private idleWaiters: Array<() => void> = [];
  /** When the worker last got an answer from the model server. */
  lastContactAt = 0;
  readonly transcriber: Transcriber | null;
  /** Takes waiting to be analysed (Whisper), and the one being analysed now. */
  private readonly analysisQueue: string[] = [];
  private analysingNow: string | null = null;
  /** Takes whose analysis failed in this run of the app, with the reason (not retried until restart). */
  readonly analysisErrors = new Map<string, string>();

  constructor(deps: { store: ProjectStore; ace: AceStepClient; bus: EventBus; config: Config; transcriber?: Transcriber | null }) {
    this.store = deps.store;
    this.transcriber = deps.transcriber ?? null;
    this.ace = deps.ace;
    this.bus = deps.bus;
    this.config = deps.config;
    this.tmpDir = path.join(this.config.dataDir, "tmp");
    mkdirSync(this.tmpDir, { recursive: true });
  }

  isBusy(): boolean {
    return this.working;
  }

  /** Call once at startup, before kick(). */
  async recover(): Promise<{ failed: number; requeued: number }> {
    const interrupted = this.store.listJobsByStatus(["running"]);
    for (const job of interrupted) {
      const error = "The app was stopped while this job was running, so its result was lost. Ask for it again.";
      this.store.updateJob(job.id, { status: "failed", error, finishedAt: Date.now() });
      this.store.setTakeStatus(job.takeId, "failed", error);
      const take = this.store.getTake(job.takeId);
      this.store.insertMessage(job.projectId, { role: "event", kind: "take_failed", text: `Take ${take?.seq ?? "?"} failed: ${error}`, takeId: job.takeId });
    }
    for (const f of await readdir(this.tmpDir).catch(() => [])) await rm(path.join(this.tmpDir, f), { force: true });
    // Finished takes that were never analysed (made before analysis existed, or the app stopped first).
    if (this.transcriber) {
      for (const p of this.store.listProjects()) {
        for (const t of this.store.listTakes(p.id)) if (t.status === "done" && !this.store.readTiming(t)) this.analysisQueue.push(t.id);
      }
    }
    return { failed: interrupted.length, requeued: this.store.listJobsByStatus(["queued"]).length };
  }

  /** Wake the worker. Safe to call any number of times. */
  kick(): void {
    if (this.working || this.stopped) return;
    this.working = true;
    void this.loop();
  }

  /** Resolves when nothing is running or queued (used by tests and by shutdown). */
  whenIdle(): Promise<void> {
    if (!this.working) return Promise.resolve();
    return new Promise((resolve) => this.idleWaiters.push(resolve));
  }

  /** Stop taking jobs. A job in flight is abandoned; it is marked failed on the next start. */
  stop(): void {
    this.stopped = true;
  }

  /** Is this take waiting for or in analysis? */
  isAnalysing(takeId: string): boolean {
    return this.analysingNow === takeId || this.analysisQueue.includes(takeId);
  }

  /** Ask for a take to be analysed (where are the words?). Runs between model jobs. */
  requestAnalysis(takeId: string, opts: { first?: boolean; force?: boolean } = {}): boolean {
    if (!this.transcriber || this.isAnalysing(takeId)) return false;
    if (opts.force) this.analysisErrors.delete(takeId);
    if (opts.first) this.analysisQueue.unshift(takeId);
    else this.analysisQueue.push(takeId);
    this.kick();
    return true;
  }

  private async loop(): Promise<void> {
    try {
      while (!this.stopped) {
        // A take's analysis runs before the next model job: it takes seconds and the person is looking at that take.
        const analysis = this.analysisQueue.shift();
        if (analysis) {
          await this.analyse(analysis);
          continue;
        }
        const next = this.store.listJobsByStatus(["queued"])[0];
        if (!next) break;
        await this.run(next);
      }
    } finally {
      this.working = false;
      for (const w of this.idleWaiters.splice(0)) w();
    }
  }

  private async analyse(takeId: string): Promise<void> {
    const take = this.store.getTake(takeId);
    const file = take ? this.store.takeAudioPath(takeId) : null;
    if (!take || !file || !this.transcriber || take.status !== "done" || this.analysisErrors.has(takeId)) return;
    this.analysingNow = takeId;
    this.bus.emit(take.projectId, { type: "state" });
    const t0 = Date.now();
    try {
      const words = await this.transcriber.transcribe(file, take.params.vocalLanguage || null, {
        lyrics: take.params.lyrics,
        durationSec: take.durationSec ?? 0,
      });
      const timing = alignLyrics(take.params.lyrics, words, take.durationSec ?? 0, this.transcriber.name);
      this.store.writeTiming(take, timing);
      this.store.log(take.projectId, "timing_found", {
        take: take.id,
        number: take.seq,
        wordsHeard: `${timing.lyricWordsHeard}/${timing.lyricWords}`,
        sections: timing.sections.map((s) => `${s.label} ${s.startSec}-${s.endSec}`),
        ms: Date.now() - t0,
      });
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      this.analysisErrors.set(takeId, reason);
      console.warn(`[analysis] take ${take.id}: ${reason}`);
      try {
        this.store.log(take.projectId, "timing_failed", { take: take.id, number: take.seq, error: reason });
      } catch {
        /* the project may have been deleted meanwhile */
      }
    } finally {
      this.analysingNow = null;
      this.bus.emit(take.projectId, { type: "state" });
    }
  }

  private publish(job: Job): void {
    this.bus.emit(job.projectId, { type: "job", job });
  }

  private async run(job: Job): Promise<void> {
    const t0 = Date.now();
    const timings: JobTimings = { queuedMs: t0 - job.createdAt };
    const take = this.store.getTake(job.takeId);
    const tmpFile = path.join(this.tmpDir, `${job.id}.wav`);
    try {
      if (!take) throw new Error("the take for this job no longer exists");
      this.store.setTakeStatus(take.id, "running");
      this.publish(this.store.updateJob(job.id, { status: "running", startedAt: t0, stage: "Sending to the model", progress: 0 }));
      this.bus.emit(job.projectId, { type: "state" });

      // 1. Submit.
      const p = take.params;
      const common = {
        stylePrompt: p.stylePrompt,
        lyrics: p.lyrics,
        bpm: p.bpm,
        key: p.key,
        timeSignature: p.timeSignature,
        vocalLanguage: p.vocalLanguage,
        seed: p.seed,
      };
      let parentPath: string | null = null;
      let taskId: string;
      if (take.kind === "generate") {
        taskId = await this.ace.submitGenerate({ ...common, durationSec: p.durationSec });
      } else {
        parentPath = take.parentTakeId ? this.store.takeAudioPath(take.parentTakeId) : null;
        if (!parentPath || !p.repaint) throw new Error("this repaint has no parent audio or no range");
        taskId = await this.ace.submitRepaint({ ...common, startSec: p.repaint.startSec, endSec: p.repaint.endSec, srcAudioPath: parentPath });
      }
      this.lastContactAt = Date.now();
      const submittedAt = Date.now();
      this.store.updateJob(job.id, { acestepTask: taskId });

      // 2. Poll.
      let file: string | null = null;
      let silentSince: number | null = null;
      while (file === null) {
        if (this.stopped) throw new Error("the app is shutting down");
        await sleep(this.config.pollIntervalMs);
        let state;
        try {
          state = await this.ace.query(taskId);
        } catch (err) {
          // The machine pages heavily during a job; one slow answer is not a failure.
          if (err instanceof AceStepError && err.kind === "unreachable") {
            silentSince ??= Date.now();
            if (Date.now() - silentSince < 90_000) continue;
          }
          throw err;
        }
        silentSince = null;
        this.lastContactAt = Date.now();
        if (state.state === "failed") throw new AceStepError("job_failed", state.error ?? "the model server reported a failure");
        if (state.state === "done") {
          if (state.audioCount !== 1) console.warn(`[queue] job ${job.id}: expected 1 audio, the model server returned ${state.audioCount}`);
          file = state.file!;
          break;
        }
        if (Date.now() - submittedAt > this.config.jobTimeoutMs) {
          throw new Error(`the model server did not finish within ${Math.round(this.config.jobTimeoutMs / 60000)} minutes`);
        }
        this.publish(
          this.store.updateJob(job.id, {
            // Keep a little headroom: download and splice still follow.
            progress: Math.min(0.95, state.progress ?? 0),
            stage: state.stage && state.stage !== "running" ? state.stage : "Generating",
            progressText: state.progressText.slice(-300) || null,
          }),
        );
      }
      timings.modelMs = Date.now() - submittedAt;

      // 3. Download.
      this.publish(this.store.updateJob(job.id, { progress: 0.96, stage: "Downloading audio" }));
      const d0 = Date.now();
      await this.ace.downloadAudio(file, tmpFile);
      this.lastContactAt = Date.now();
      timings.downloadMs = Date.now() - d0;

      // 4. Finalise the take.
      const f0 = Date.now();
      const finalPath = this.store.takePath(take, ".wav");
      const finalName = path.basename(finalPath);
      let audio: WavAudio;
      let checks: SpliceChecks | null = null;
      if (take.kind === "generate") {
        audio = await readWavFile(tmpFile); // validates that it really is 16-bit PCM
        await rename(tmpFile, finalPath);
      } else {
        this.publish(this.store.updateJob(job.id, { progress: 0.98, stage: "Splicing into the parent take" }));
        const parent = await readWavFile(parentPath!);
        const server = await readWavFile(tmpFile);
        const spliced = spliceRepaint(parent, server, { startSec: p.repaint!.startSec, endSec: p.repaint!.endSec });
        audio = spliced.audio;
        checks = spliced.checks;
        await writeWavFile(finalPath, audio);
        if (checks.status === "verified") {
          // Trust nothing: compare the bytes that actually landed on disk with the parent's file.
          const written = await readWavFile(finalPath);
          const cmp = compareOutside(written, parent, checks.startFrame, checks.endFrame);
          checks.outsideSamples = cmp.compared;
          checks.outsideMismatches = cmp.mismatches;
          checks.bitIdenticalOutside = cmp.mismatches === 0;
          if (cmp.mismatches !== 0) {
            checks.status = "failed";
            checks.reason = `${cmp.mismatches} samples outside the range differ from the parent in the written file`;
          }
        }
        if (this.config.keepRawRepaint) await rename(tmpFile, this.store.takePath(take, ".model-output.wav"));
        else await rm(tmpFile, { force: true });
      }
      await writeFile(this.store.takePath(take, ".peaks.json"), JSON.stringify(computePeaks(audio, PEAK_POINTS)));
      timings.finaliseMs = Date.now() - f0;
      timings.totalMs = Date.now() - t0;

      this.store.tx(() => {
        this.store.finaliseTake(take.id, { audioFile: finalName, durationSec: durationSeconds(audio), sampleRate: audio.sampleRate, checks });
        this.store.updateProject(take.projectId, { currentTakeId: take.id });
        this.store.updateJob(job.id, { status: "done", progress: 1, stage: "Done", finishedAt: Date.now(), timings });
      });
      const text =
        take.kind === "generate"
          ? `Take ${take.seq} is ready (${durationSeconds(audio).toFixed(1)} s).`
          : `Take ${take.seq} is ready. ${describeChecks(checks!)}`;
      const message = this.store.insertMessage(take.projectId, { role: "event", kind: "take_ready", text, takeId: take.id });
      this.publish(this.store.getJob(job.id)!);
      this.bus.emit(take.projectId, { type: "chat.message", message });
      this.bus.emit(take.projectId, { type: "state" });
      this.requestAnalysis(take.id, { first: true });
    } catch (err) {
      await rm(tmpFile, { force: true });
      await rm(`${tmpFile}.part`, { force: true });
      const error = err instanceof Error ? err.message : String(err);
      timings.totalMs = Date.now() - t0;
      if (this.stopped) return; // leave it `running`; recover() fails it with the right explanation
      this.store.tx(() => {
        this.store.updateJob(job.id, { status: "failed", error, finishedAt: Date.now(), timings });
        if (take) this.store.setTakeStatus(take.id, "failed", error);
      });
      const message = this.store.insertMessage(job.projectId, {
        role: "event",
        kind: "take_failed",
        text: `Take ${take?.seq ?? "?"} failed: ${error}`,
        takeId: job.takeId,
      });
      this.publish(this.store.getJob(job.id)!);
      this.bus.emit(job.projectId, { type: "chat.message", message });
      this.bus.emit(job.projectId, { type: "state" });
    }
  }
}

