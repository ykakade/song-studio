// Client for the ACE-Step 1.5 REST API. Every quirk measured in the spike
// (~/song-studio/spike/results.md) is handled here and nowhere else:
//
//  * audio_format must be "wav": the default is mp3, which needs ffmpeg; without
//    it the job "succeeds" with an empty `file` and the error only in progress_text.
//  * batch_size must be 1 (default 2), use_cot_* off, inference_steps 8.
//  * thinking (the 5Hz LM "planner") is on for new songs unless disabled; the
//    server ignores it for repaint, so repaint always sends false.
//  * `result` in /query_result is a STRING holding a JSON array, one object per audio.
//  * `file` is a path like /v1/audio?path=<encoded>, fetched from the same server.
//  * Repaint: absolute src_audio_path values are rejected with HTTP 400, so the
//    source audio is uploaded as the multipart field `src_audio`.
//  * Repaint takes no audio_duration (the length never changes) and needs
//    chunk_mask_mode "explicit" plus the FULL lyrics.
//  * use_random_seed false + an explicit seed gives byte-identical output.
//  * The server can only run one job at a time on this machine; the queue
//    (queue.ts) guarantees we never submit two.

import { randomBytes } from "node:crypto";
import { createWriteStream } from "node:fs";
import { readFile, rename, rm } from "node:fs/promises";
import path from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";

export class AceStepError extends Error {
  readonly kind: "unreachable" | "http" | "protocol" | "job_failed";
  readonly status?: number;
  constructor(kind: AceStepError["kind"], message: string, status?: number) {
    super(message);
    this.name = "AceStepError";
    this.kind = kind;
    this.status = status;
  }
}

/** Musical parameters shared by generate and repaint. */
export interface SongParams {
  /** Style description ("prompt" in ACE-Step). */
  stylePrompt: string;
  /** Complete lyrics with section tags like [verse]. */
  lyrics: string;
  bpm: number;
  /** e.g. "C Major", "A minor". */
  key: string;
  timeSignature: string;
  vocalLanguage: string;
  seed: number;
}

export interface GenerateRequest extends SongParams {
  durationSec: number;
}

export interface RepaintRequest extends SongParams {
  startSec: number;
  endSec: number;
  /** Path of the WAV to repaint (the parent take). */
  srcAudioPath: string;
}

export interface AceHealth {
  ok: boolean;
  modelsInitialized: boolean | null;
  loadedModel: string | null;
  error: string | null;
}

export interface AceTaskState {
  state: "running" | "done" | "failed";
  /** 0..1 while running, when the server reports it. */
  progress: number | null;
  stage: string | null;
  /** Last server log line; the only place some errors show up. */
  progressText: string;
  /** Server-relative audio reference ("/v1/audio?path=..."), set when done. */
  file: string | null;
  error: string | null;
  /** Number of audios in the result (should be 1). */
  audioCount: number;
}

/** Fields every request must carry, whatever the task. */
const FIXED_FIELDS = {
  inference_steps: 8,
  use_random_seed: false,
  batch_size: 1,
  thinking: false,
  use_cot_caption: false,
  use_cot_language: false,
  audio_format: "wav",
} as const;

function commonFields(p: SongParams): Record<string, string | number | boolean> {
  return {
    prompt: p.stylePrompt,
    lyrics: p.lyrics,
    bpm: p.bpm,
    key_scale: p.key,
    time_signature: p.timeSignature,
    vocal_language: p.vocalLanguage,
    seed: p.seed,
    ...FIXED_FIELDS,
  };
}

/**
 * The exact JSON body for a text2music job (exported for tests and for the README).
 * With `lmPlanner` the server's language model first plans the song as semantic
 * codes and the diffusion model follows them; slower, but the docs recommend it
 * for quality. The caption and language are still passed through untouched.
 */
export function buildGenerateBody(req: GenerateRequest, lmPlanner = true): Record<string, string | number | boolean> {
  return { ...commonFields(req), thinking: lmPlanner, task_type: "text2music", audio_duration: req.durationSec };
}

/** The form fields for a repaint job, without the audio upload. Note: no audio_duration. */
export function buildRepaintFields(req: RepaintRequest): Record<string, string | number | boolean> {
  return {
    ...commonFields(req),
    task_type: "repaint",
    repainting_start: req.startSec,
    repainting_end: req.endSec,
    chunk_mask_mode: "explicit",
  };
}

/**
 * multipart/form-data, written by hand on purpose: the built-in FormData
 * rewrites every "\n" in a text field to "\r\n" (that is what the HTML spec
 * says), which would silently change the lyrics the model receives. curl -F,
 * which the spike used, sends them untouched; so do we.
 */
export function encodeMultipart(
  fields: Record<string, string | number | boolean>,
  file: { field: string; filename: string; contentType: string; bytes: Buffer },
): { body: Buffer; contentType: string } {
  const boundary = `----songstudio${randomBytes(12).toString("hex")}`;
  const parts: Buffer[] = [];
  for (const [name, value] of Object.entries(fields)) {
    parts.push(Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="${name}"\r\n\r\n${String(value)}\r\n`, "utf8"));
  }
  const safeName = file.filename.replace(/["\r\n]/g, "_");
  parts.push(
    Buffer.from(
      `--${boundary}\r\nContent-Disposition: form-data; name="${file.field}"; filename="${safeName}"\r\nContent-Type: ${file.contentType}\r\n\r\n`,
      "utf8",
    ),
    file.bytes,
    Buffer.from(`\r\n--${boundary}--\r\n`, "utf8"),
  );
  return { body: Buffer.concat(parts), contentType: `multipart/form-data; boundary=${boundary}` };
}

export class AceStepClient {
  readonly baseUrl: string;
  /** Whether new songs use the server's LM planner (`thinking`). */
  readonly lmPlanner: boolean;

  constructor(baseUrl: string, opts: { lmPlanner?: boolean } = {}) {
    this.baseUrl = baseUrl.replace(/\/+$/, "");
    this.lmPlanner = opts.lmPlanner ?? true;
  }

  private async request(pathname: string, init: RequestInit, timeoutMs: number): Promise<Response> {
    try {
      return await fetch(this.baseUrl + pathname, { ...init, signal: AbortSignal.timeout(timeoutMs) });
    } catch (err) {
      const cause = err instanceof Error ? ((err.cause as Error | undefined)?.message ?? err.message) : String(err);
      throw new AceStepError("unreachable", `cannot reach the model server at ${this.baseUrl} (${cause})`);
    }
  }

  private async json(res: Response): Promise<any> {
    const text = await res.text();
    let body: any = null;
    try {
      body = JSON.parse(text);
    } catch {
      /* fall through */
    }
    if (!res.ok) {
      const detail = body?.detail ?? body?.error ?? text.slice(0, 300);
      throw new AceStepError("http", `model server answered HTTP ${res.status}: ${typeof detail === "string" ? detail : JSON.stringify(detail)}`, res.status);
    }
    if (body === null) throw new AceStepError("protocol", `model server sent something that is not JSON: ${text.slice(0, 200)}`);
    if (typeof body.code === "number" && body.code !== 200) {
      throw new AceStepError("http", `model server reported an error: ${body.error ?? JSON.stringify(body).slice(0, 300)}`, body.code);
    }
    return body;
  }

  async health(timeoutMs = 3000): Promise<AceHealth> {
    try {
      const body = await this.json(await this.request("/health", { method: "GET" }, timeoutMs));
      const d = body?.data ?? body ?? {};
      return {
        ok: d.status === "ok",
        modelsInitialized: typeof d.models_initialized === "boolean" ? d.models_initialized : null,
        loadedModel: typeof d.loaded_model === "string" ? d.loaded_model : null,
        error: d.status === "ok" ? null : `unexpected /health answer: ${JSON.stringify(d).slice(0, 200)}`,
      };
    } catch (err) {
      return { ok: false, modelsInitialized: null, loadedModel: null, error: (err as Error).message };
    }
  }

  private taskIdFrom(body: any): string {
    const id = body?.data?.task_id;
    if (typeof id !== "string" || !id) {
      throw new AceStepError("protocol", `no task_id in /release_task answer: ${JSON.stringify(body).slice(0, 300)}`);
    }
    return id;
  }

  /** Submit a text2music job. Returns the task id. */
  async submitGenerate(req: GenerateRequest): Promise<string> {
    const res = await this.request(
      "/release_task",
      { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(buildGenerateBody(req, this.lmPlanner)) },
      60_000,
    );
    return this.taskIdFrom(await this.json(res));
  }

  /** Submit a repaint job; the source audio is uploaded as multipart field `src_audio`. Returns the task id. */
  async submitRepaint(req: RepaintRequest): Promise<string> {
    const bytes = await readFile(req.srcAudioPath);
    const { body, contentType } = encodeMultipart(buildRepaintFields(req), {
      field: "src_audio",
      filename: path.basename(req.srcAudioPath),
      contentType: "audio/wav",
      bytes,
    });
    const res = await this.request(
      "/release_task",
      { method: "POST", headers: { "content-type": contentType, "content-length": String(body.length) }, body: new Uint8Array(body) },
      120_000,
    );
    return this.taskIdFrom(await this.json(res));
  }

  async query(taskId: string): Promise<AceTaskState> {
    const res = await this.request(
      "/query_result",
      { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ task_id_list: [taskId] }) },
      30_000,
    );
    const body = await this.json(res);
    const entry = Array.isArray(body?.data) ? body.data.find((d: any) => d?.task_id === taskId) ?? body.data[0] : null;
    if (!entry) throw new AceStepError("protocol", `task ${taskId} is missing from the /query_result answer`);

    // `result` is a string containing a JSON array, one object per audio.
    let items: any[] = [];
    if (typeof entry.result === "string" && entry.result.trim()) {
      try {
        const parsed = JSON.parse(entry.result);
        if (Array.isArray(parsed)) items = parsed;
      } catch {
        throw new AceStepError("protocol", `cannot parse the result string of task ${taskId}`);
      }
    } else if (Array.isArray(entry.result)) {
      items = entry.result;
    }
    const first = items[0] ?? {};
    const progressText = typeof entry.progress_text === "string" ? entry.progress_text : "";
    const progress = typeof first.progress === "number" ? Math.max(0, Math.min(1, first.progress)) : null;
    const stage = typeof first.stage === "string" ? first.stage : null;
    const base = { progress, stage, progressText, audioCount: items.length };

    if (entry.status === 0) return { ...base, state: "running", file: null, error: null };
    if (entry.status === 2) {
      const reason = (typeof first.error === "string" && first.error) || progressText || "the model server reported a failure without a message";
      return { ...base, state: "failed", file: null, error: reason };
    }
    if (entry.status === 1) {
      const file = typeof first.file === "string" ? first.file : "";
      if (!file) {
        // The mp3-without-ffmpeg case: status 1 but nothing was written.
        return {
          ...base,
          state: "failed",
          file: null,
          error: `the model server finished but produced no audio file${progressText ? `: ${progressText}` : ""}`,
        };
      }
      return { ...base, state: "done", file, error: null };
    }
    throw new AceStepError("protocol", `unknown task status ${JSON.stringify(entry.status)} for task ${taskId}`);
  }

  /** Download a finished audio (`file` from query()) to destPath. Returns the byte count. */
  async downloadAudio(file: string, destPath: string): Promise<number> {
    if (!file.startsWith("/")) throw new AceStepError("protocol", `unexpected audio reference: ${file}`);
    const res = await this.request(file, { method: "GET" }, 120_000);
    if (!res.ok || !res.body) {
      throw new AceStepError("http", `downloading the audio failed with HTTP ${res.status}`, res.status);
    }
    const tmp = `${destPath}.part`;
    try {
      await pipeline(Readable.fromWeb(res.body as any), createWriteStream(tmp));
      await rename(tmp, destPath);
    } catch (err) {
      await rm(tmp, { force: true });
      throw new AceStepError("unreachable", `downloading the audio was interrupted: ${(err as Error).message}`);
    }
    const len = Number(res.headers.get("content-length"));
    return Number.isFinite(len) ? len : 0;
  }
}
