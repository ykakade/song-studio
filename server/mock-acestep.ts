// A stand-in for the ACE-Step 1.5 REST API, for development and tests.
// Same routes and response shapes as the real server (see the spike notes),
// including its quirks:
//   - audio_format defaults to mp3, which "succeeds" with an empty `file`
//   - batch_size defaults to 2
//   - absolute src_audio_path is rejected with HTTP 400
//   - repaint keeps the source outside the range, crossfades ~25 ms, then
//     scales the WHOLE file by one gain and truncates to 16 bits
// Audio comes from two short clips of real model output in test/fixtures.
//
// Run standalone:  node server/mock-acestep.ts   (MOCK_ACESTEP_PORT, MOCK_ACESTEP_DELAY_MS)
//
// Test hooks, triggered by text in the style prompt:
//   [mock:fail]   the job ends with status 2
//   [mock:regen]  a repaint returns unrelated audio everywhere (splice must fall back)

import { serve } from "@hono/node-server";
import { Hono } from "hono";
import { randomUUID } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { APP_ROOT } from "./config.ts";
import { decodeWav, encodeWav, type WavAudio } from "./wav.ts";

export interface MockOptions {
  /** How long a job "computes". Default 3000 ms. */
  delayMs?: number;
  fixturesDir?: string;
}

interface MockTask {
  id: string;
  fields: Record<string, string>;
  srcAudio: Buffer | null;
  createdAt: number;
  startedAt: number | null;
  status: 0 | 1 | 2;
  files: string[];
  progressText: string;
  error: string | null;
}

export interface MockAceStep {
  app: Hono;
  /** Every /release_task body received, as string fields (for assertions). */
  requests: Array<{ fields: Record<string, string>; hadUpload: boolean; contentType: string }>;
  stats: { submitted: number; maxConcurrent: number; running: number };
  listen(port: number, host?: string): Promise<{ url: string; port: number; close(): Promise<void> }>;
  cleanup(): void;
}

function wrap(data: unknown) {
  return { data, code: 200, error: null, timestamp: Date.now(), extra: null };
}

function num(v: string | undefined, fallback: number): number {
  const n = Number(v);
  return v !== undefined && v !== "" && Number.isFinite(n) ? n : fallback;
}

/** Copy `frames` frames out of `clip`, starting at `offset` and wrapping around. */
function tile(clip: WavAudio, offsetFrames: number, frames: number): Int16Array {
  const ch = clip.channels;
  const clipFrames = clip.samples.length / ch;
  const out = new Int16Array(frames * ch);
  let pos = ((offsetFrames % clipFrames) + clipFrames) % clipFrames;
  let written = 0;
  while (written < frames) {
    const n = Math.min(frames - written, clipFrames - pos);
    out.set(clip.samples.subarray(pos * ch, (pos + n) * ch), written * ch);
    written += n;
    pos = (pos + n) % clipFrames;
  }
  return out;
}

export function createMockAceStep(opts: MockOptions = {}): MockAceStep {
  const delayMs = opts.delayMs ?? 3000;
  const fixturesDir = opts.fixturesDir ?? path.join(APP_ROOT, "test", "fixtures");
  const outDir = mkdtempSync(path.join(os.tmpdir(), "song-studio-mock-acestep-"));
  const original = decodeWav(readFileSync(path.join(fixturesDir, "folk_orig_16s.wav")));
  const repainted = decodeWav(readFileSync(path.join(fixturesDir, "folk_repaint_16s.wav")));
  // The model-made "new section" lives at 1.5-14.5 s of the repaint clip; stay clear of its edges.
  const sr = repainted.sampleRate;
  const freshClip: WavAudio = {
    sampleRate: sr,
    channels: repainted.channels,
    samples: repainted.samples.subarray(Math.round(1.7 * sr) * repainted.channels, Math.round(14.3 * sr) * repainted.channels),
  };

  const tasks = new Map<string, MockTask>();
  const requests: MockAceStep["requests"] = [];
  const stats = { submitted: 0, maxConcurrent: 0, running: 0 };

  function renderGenerate(f: Record<string, string>): WavAudio {
    const seconds = Math.max(1, Math.min(600, num(f.audio_duration, 30)));
    const seed = Math.abs(Math.trunc(num(f.seed, 0)));
    const frames = Math.round(seconds * original.sampleRate);
    return {
      sampleRate: original.sampleRate,
      channels: original.channels,
      samples: tile(original, (seed % 8) * original.sampleRate, frames),
    };
  }

  function renderRepaint(f: Record<string, string>, src: WavAudio): WavAudio {
    const { sampleRate, channels: ch } = src;
    const frames = src.samples.length / ch;
    const seed = Math.abs(Math.trunc(num(f.seed, 0)));
    const fresh = tile(freshClip, (seed % 7) * sampleRate, frames);
    if ((f.prompt ?? "").includes("[mock:regen]")) {
      return { sampleRate, channels: ch, samples: fresh };
    }
    const s = Math.round(Math.max(0, num(f.repainting_start, 0)) * sampleRate);
    const endSec = num(f.repainting_end, -1);
    const e = endSec < 0 ? frames : Math.min(frames, Math.round(endSec * sampleRate));
    const x = Math.round(0.025 * sampleRate);
    // Peak-normalisation side effect: one uniform gain between -0.1 and -0.5 dB, then truncation.
    const gain = 10 ** (-(0.1 + (seed % 5) * 0.1) / 20);
    const out = new Int16Array(src.samples.length);
    for (let fr = 0; fr < frames; fr++) {
      let w = 0;
      if (fr >= s && fr < e) w = 1;
      else if (fr >= s - x && fr < s) w = (fr - (s - x)) / x;
      else if (fr >= e && fr < e + x) w = 1 - (fr - e) / x;
      for (let c = 0; c < ch; c++) {
        const i = fr * ch + c;
        const v = Math.floor(((1 - w) * src.samples[i] + w * fresh[i]) * gain);
        out[i] = v > 32767 ? 32767 : v < -32768 ? -32768 : v;
      }
    }
    return { sampleRate, channels: ch, samples: out };
  }

  async function finish(task: MockTask): Promise<void> {
    const f = task.fields;
    try {
      if ((f.prompt ?? "").includes("[mock:fail]")) throw new Error("mock failure requested by [mock:fail]");
      const format = f.audio_format ?? "mp3";
      const batch = Math.max(1, Math.trunc(num(f.batch_size, 2)));
      if (format !== "wav") {
        // Exactly what the real server does without ffmpeg: status 1, empty file.
        task.files = new Array(batch).fill("");
        task.progressText =
          "ERROR | [generate_music] Failed to save audio file: ffmpeg executable not found. Install ffmpeg or add it to PATH to export MP3 files.";
        task.status = 1;
        return;
      }
      for (let b = 0; b < batch; b++) {
        const fb = { ...f, seed: String(num(f.seed, 0) + b) };
        const audio = f.task_type === "repaint" ? renderRepaint(fb, decodeWav(task.srcAudio!)) : renderGenerate(fb);
        const file = path.join(outDir, `${randomUUID()}.wav`);
        await writeFile(file, encodeWav(audio));
        task.files.push(file);
      }
      task.progressText = `DEBUG | [AudioSaver] Saved audio to ${task.files[0]} (wav, 48000Hz)`;
      task.status = 1;
    } catch (err) {
      task.error = (err as Error).message;
      task.progressText = `ERROR | ${task.error}`;
      task.status = 2;
    } finally {
      stats.running--;
    }
  }

  // One job at a time, like the real server's single worker.
  let chain: Promise<void> = Promise.resolve();
  function schedule(task: MockTask): void {
    chain = chain.then(async () => {
      task.startedAt = Date.now();
      stats.running++;
      stats.maxConcurrent = Math.max(stats.maxConcurrent, stats.running);
      await new Promise((r) => setTimeout(r, delayMs));
      await finish(task);
    });
  }

  const app = new Hono();

  app.get("/health", (c) =>
    c.json(
      wrap({
        status: "ok",
        service: "ACE-Step API",
        version: "1.0",
        models_initialized: true,
        llm_initialized: true,
        loaded_model: "mock-acestep-v15-turbo",
        loaded_lm_model: "mock",
      }),
    ),
  );

  app.post("/release_task", async (c) => {
    const contentType = c.req.header("content-type") ?? "";
    const fields: Record<string, string> = {};
    let srcAudio: Buffer | null = null;
    if (contentType.includes("multipart/form-data")) {
      const form = await c.req.formData();
      for (const [k, v] of form.entries()) {
        if (typeof v === "string") fields[k] = v;
        else if (k === "src_audio") srcAudio = Buffer.from(await v.arrayBuffer());
      }
    } else {
      let body: Record<string, unknown>;
      try {
        body = await c.req.json();
      } catch {
        return c.json({ detail: "invalid JSON body" }, 400);
      }
      for (const [k, v] of Object.entries(body)) fields[k] = typeof v === "string" ? v : JSON.stringify(v);
    }
    requests.push({ fields, hadUpload: srcAudio !== null, contentType });

    if (fields.src_audio_path && path.isAbsolute(fields.src_audio_path)) {
      return c.json({ detail: "absolute audio file paths are not allowed" }, 400);
    }
    if (fields.task_type === "repaint") {
      if (!srcAudio) return c.json({ detail: "repaint requires source audio (upload it as src_audio)" }, 400);
      try {
        decodeWav(srcAudio);
      } catch (err) {
        return c.json({ detail: `cannot read src_audio: ${(err as Error).message}` }, 400);
      }
    }

    const task: MockTask = {
      id: randomUUID(),
      fields,
      srcAudio,
      createdAt: Date.now(),
      startedAt: null,
      status: 0,
      files: [],
      progressText: "INFO | queued",
      error: null,
    };
    tasks.set(task.id, task);
    stats.submitted++;
    schedule(task);
    return c.json(wrap({ task_id: task.id, status: "queued", queue_position: 1 }));
  });

  app.post("/query_result", async (c) => {
    const body = (await c.req.json().catch(() => ({}))) as { task_id_list?: unknown };
    const ids = Array.isArray(body.task_id_list) ? (body.task_id_list as string[]) : [];
    const data = ids.map((id) => {
      const t = tasks.get(id);
      if (!t) {
        return { task_id: id, result: JSON.stringify([{ file: "", wave: "", status: 0, progress: 0, stage: "queued" }]), status: 0, progress_text: "" };
      }
      const create_time = Math.floor(t.createdAt / 1000);
      let result: unknown[];
      let progressText = t.progressText;
      if (t.status === 0) {
        const p = t.startedAt === null ? 0 : Math.min(0.99, (Date.now() - t.startedAt) / Math.max(1, delayMs));
        const stage = t.startedAt === null ? "queued" : p < 0.15 ? "Preparing inputs..." : p < 0.8 ? `Diffusion step ${Math.min(8, 1 + Math.floor(((p - 0.15) / 0.65) * 8))}/8` : "Decoding audio...";
        result = [{ file: "", wave: "", status: 0, create_time, env: "development", prompt: "", lyrics: "", metas: {}, progress: p, stage, error: null }];
        progressText = `INFO | ${stage}`;
      } else if (t.status === 2) {
        result = [{ file: "", wave: "", status: 2, create_time, env: "development", prompt: "", lyrics: "", metas: {}, progress: 0, stage: "failed", error: t.error }];
      } else {
        result = t.files.map((file) => ({
          file: file ? `/v1/audio?path=${encodeURIComponent(file)}` : "",
          wave: "",
          status: 1,
          create_time,
          env: "development",
          prompt: t.fields.prompt ?? "",
          lyrics: t.fields.lyrics ?? "",
          metas: {
            bpm: num(t.fields.bpm, 120),
            duration: num(t.fields.audio_duration, 30),
            genres: "N/A",
            keyscale: t.fields.key_scale ?? "",
            timesignature: t.fields.time_signature ?? "4",
          },
          generation_info: `**Total generation time (1 song): ${(delayMs / 1000).toFixed(2)}s** (mock)`,
          seed_value: t.fields.seed ?? "0",
          lm_model: "mock",
          dit_model: "mock-acestep-v15-turbo",
          progress: 1.0,
          stage: "succeeded",
        }));
      }
      return { task_id: id, result: JSON.stringify(result), status: t.status, progress_text: progressText };
    });
    return c.json(wrap(data));
  });

  app.get("/v1/audio", async (c) => {
    const p = c.req.query("path") ?? "";
    const resolved = path.resolve(p);
    if (!resolved.startsWith(outDir + path.sep)) return c.json({ detail: "not found" }, 404);
    try {
      const bytes = await readFile(resolved);
      return c.body(new Uint8Array(bytes), 200, { "content-type": "audio/wav", "accept-ranges": "bytes", "content-length": String(bytes.length) });
    } catch {
      return c.json({ detail: "not found" }, 404);
    }
  });

  return {
    app,
    requests,
    stats,
    cleanup: () => rmSync(outDir, { recursive: true, force: true }),
    listen(port: number, host = "127.0.0.1") {
      return new Promise((resolve, reject) => {
        const server = serve({ fetch: app.fetch, port, hostname: host }, (info) => {
          resolve({
            url: `http://${host}:${info.port}`,
            port: info.port,
            close: () =>
              new Promise<void>((done) => {
                rmSync(outDir, { recursive: true, force: true });
                (server as any).closeAllConnections?.();
                server.close(() => done());
              }),
          });
        });
        server.on("error", reject);
      });
    },
  };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const port = Number(process.env.MOCK_ACESTEP_PORT ?? 8001);
  const host = process.env.MOCK_ACESTEP_HOST ?? "127.0.0.1";
  const mock = createMockAceStep({ delayMs: Number(process.env.MOCK_ACESTEP_DELAY_MS ?? 3000) });
  const { url, close } = await mock.listen(port, host);
  console.log(`mock ACE-Step listening on ${url}`);
  const stop = () => void close().then(() => process.exit(0));
  process.on("SIGINT", stop);
  process.on("SIGTERM", stop);
}
