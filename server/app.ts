// Wires everything together and defines the HTTP API.

import { serve } from "@hono/node-server";
import { Hono } from "hono";
import { streamSSE } from "hono/streaming";
import { createReadStream, existsSync, mkdirSync, readFileSync } from "node:fs";
import { readFile, stat } from "node:fs/promises";
import path from "node:path";
import { Readable } from "node:stream";
import { AceStepClient } from "./acestep.ts";
import { Agent, AgentBusyError } from "./agent/loop.ts";
import { projectStateForAgent } from "./agent/tools.ts";
import { APP_ROOT, projectsDirOf, type Config } from "./config.ts";
import { handleMcp } from "./mcp.ts";
import { migrateFromSqlite } from "./migrate.ts";
import { ProjectStore } from "./store.ts";
import { EventBus } from "./events.ts";
import { createLlm, type LlmClient } from "./llm/index.ts";
import { JobQueue } from "./queue.ts";
import { renderSound, SOUND_LIBRARY } from "./sounds.ts";
import { Studio, StudioError } from "./studio.ts";
import { type Transcriber, WhisperTranscriber } from "./transcribe.ts";
import type { Health, ProjectState, Selection, StudioEvent } from "./types.ts";
import { encodeWav } from "./wav.ts";

const APP_VERSION: string = JSON.parse(readFileSync(path.join(APP_ROOT, "package.json"), "utf8")).version;

export interface SongStudioApp {
  hono: Hono;
  config: Config;
  store: ProjectStore;
  bus: EventBus;
  queue: JobQueue;
  studio: Studio;
  agent: Agent;
  llm: LlmClient;
  /** Recover interrupted jobs and start listening. Resolves with the bound address. */
  start(): Promise<{ url: string; port: number }>;
  close(): Promise<void>;
}

function selectionFrom(v: unknown): Selection | null {
  if (!v || typeof v !== "object") return null;
  const s = v as Record<string, unknown>;
  return typeof s.startSec === "number" && typeof s.endSec === "number" && Number.isFinite(s.startSec) && Number.isFinite(s.endSec)
    ? { startSec: s.startSec, endSec: s.endSec }
    : null;
}

export function createApp(config: Config, overrides: { llm?: LlmClient; transcriber?: Transcriber | null } = {}): SongStudioApp {
  mkdirSync(config.dataDir, { recursive: true });
  const store = new ProjectStore(projectsDirOf(config));
  const migrated = migrateFromSqlite(config.dataDir, store);
  if (migrated) console.log(`[store] moved ${migrated.projects} project(s) and ${migrated.takes} take(s) from studio.db into ${store.root}`);
  const bus = new EventBus();
  const ace = new AceStepClient(config.acestepUrl, { lmPlanner: config.lmPlanner });
  const transcriber = overrides.transcriber !== undefined ? overrides.transcriber : config.timing ? new WhisperTranscriber() : null;
  const queue = new JobQueue({ store, ace, bus, config, transcriber });
  const studio = new Studio({ store, config, ace, bus, queue });
  const llm = overrides.llm ?? createLlm(config);
  const agent = new Agent({ studio, llm });

  const app = new Hono();
  const liveStreams = new Set<() => void>();
  let closing = false;

  app.onError((err, c) => {
    if (err instanceof StudioError) {
      const status = err.code === "not_found" ? 404 : err.code === "conflict" ? 409 : err.code === "model_server_unreachable" ? 503 : 400;
      return c.json({ error: err.message, code: err.code }, status);
    }
    if (err instanceof AgentBusyError) return c.json({ error: err.message, code: "busy" }, 409);
    if (err instanceof SyntaxError) return c.json({ error: "The request body is not valid JSON.", code: "invalid" }, 400);
    console.error("[http]", err);
    return c.json({ error: "Internal error. See the server log.", code: "internal" }, 500);
  });

  // --- health ------------------------------------------------------------------------

  let healthCache: { at: number; value: Health["modelServer"] } | null = null;
  async function modelServerHealth(): Promise<Health["modelServer"]> {
    const busy = queue.isBusy();
    // Mid-job the model server may be too busy paging to answer /health; the worker's own contact is proof enough.
    if (busy && Date.now() - queue.lastContactAt < 60_000) return { reachable: true, url: config.acestepUrl, error: null, busy };
    if (healthCache && Date.now() - healthCache.at < 2000) return { ...healthCache.value, busy };
    const h = await ace.health(2500);
    const value = { reachable: h.ok, url: config.acestepUrl, error: h.error, busy };
    healthCache = { at: Date.now(), value };
    return value;
  }

  app.get("/api/health", async (c) => {
    const problem = llm.problem();
    const health: Health = {
      modelServer: await modelServerHealth(),
      llm: { provider: llm.provider, model: llm.model, ready: problem === null, problem },
    };
    return c.json(health);
  });

  // --- projects ----------------------------------------------------------------------

  app.get("/api/projects", (c) => c.json({ projects: studio.listProjects() }));

  app.post("/api/projects", async (c) => {
    const body = await c.req.json().catch(() => ({}));
    return c.json({ project: studio.createProject(typeof body?.title === "string" ? body.title : undefined) }, 201);
  });

  function projectState(id: string): ProjectState {
    return { ...studio.snapshot(id), messages: store.listMessages(id), chatBusy: agent.isBusy(id) };
  }

  app.get("/api/projects/:id", (c) => c.json(projectState(c.req.param("id"))));

  app.patch("/api/projects/:id", async (c) => {
    const body = await c.req.json();
    return c.json({ project: studio.renameProject(c.req.param("id"), body?.title) });
  });

  app.delete("/api/projects/:id", async (c) => {
    if (agent.isBusy(c.req.param("id"))) throw new StudioError("conflict", "the assistant is still working in this project");
    await studio.deleteProject(c.req.param("id"));
    return c.json({ deleted: true });
  });

  /** What the agent's get_project_state tool returns (handy for debugging prompts). */
  app.get("/api/projects/:id/agent-state", (c) => {
    studio.project(c.req.param("id"));
    return c.json(projectStateForAgent(studio, c.req.param("id")));
  });

  app.get("/api/projects/:id/events", (c) => {
    const id = c.req.param("id");
    studio.project(id);
    return streamSSE(c, async (stream) => {
      let open = true;
      const send = (ev: StudioEvent) => {
        if (open) void stream.writeSSE({ data: JSON.stringify(ev) }).catch(() => {});
      };
      const unsubscribe = bus.subscribe(id, send);
      let wake: () => void = () => {};
      let timer: NodeJS.Timeout | undefined;
      const end = () => {
        open = false;
        unsubscribe();
        liveStreams.delete(end);
        clearTimeout(timer);
        wake();
      };
      liveStreams.add(end);
      stream.onAbort(end);
      send({ type: "state" });
      // Keep-alive pings; the wait ends early when the client goes away or the app closes.
      while (open && !closing) {
        await new Promise<void>((resolve) => {
          wake = resolve;
          timer = setTimeout(resolve, 15_000);
        });
        if (open) await stream.writeSSE({ event: "ping", data: "" }).catch(end);
      }
      end();
    });
  });

  // --- chat --------------------------------------------------------------------------

  app.post("/api/projects/:id/chat", async (c) => {
    const body = await c.req.json();
    const text = typeof body?.text === "string" ? body.text.trim() : "";
    if (!text) throw new StudioError("invalid", "The message is empty.");
    if (text.length > 8000) throw new StudioError("invalid", "The message is too long.");
    const message = agent.send(c.req.param("id"), text, selectionFrom(body?.selection));
    return c.json({ message }, 202);
  });

  // --- the same operations the agent's tools use, callable directly ---------------------------

  app.post("/api/projects/:id/generate", async (c) => {
    const b = await c.req.json();
    const r = await studio.startGenerate(c.req.param("id"), {
      title: b?.title,
      stylePrompt: b?.stylePrompt,
      lyrics: b?.lyrics,
      bpm: b?.bpm,
      key: b?.key,
      durationSec: b?.durationSec,
      timeSignature: b?.timeSignature,
      vocalLanguage: b?.vocalLanguage,
      seed: b?.seed,
    });
    return c.json(r, 202);
  });

  app.post("/api/projects/:id/repaint", async (c) => {
    const b = await c.req.json();
    const r = await studio.startRepaint(c.req.param("id"), {
      takeId: b?.takeId,
      startSec: b?.startSec,
      endSec: b?.endSec,
      lyrics: b?.lyrics,
      stylePrompt: b?.stylePrompt,
      seed: b?.seed,
      changeSummary: b?.changeSummary,
      joins: b?.joins,
    });
    return c.json(r, 202);
  });

  app.put("/api/projects/:id/markers", async (c) => {
    const b = await c.req.json();
    return c.json({ markers: studio.setMarkers(c.req.param("id"), b?.markers) });
  });

  app.post("/api/projects/:id/current-take", async (c) => {
    const b = await c.req.json();
    return c.json({ take: studio.setCurrentTake(c.req.param("id"), String(b?.takeId ?? "")) });
  });

  app.get("/api/projects/:id/takes/:takeId/timing", (c) => {
    const id = c.req.param("id");
    const takeId = c.req.param("takeId");
    return c.json({ timing: studio.timing(id, takeId), analysing: queue.isAnalysing(takeId), error: queue.analysisErrors.get(takeId) ?? null });
  });

  app.post("/api/projects/:id/takes/:takeId/analyse", (c) => c.json(studio.analyseTake(c.req.param("id"), c.req.param("takeId")), 202));

  app.get("/api/projects/:id/history", (c) => {
    studio.project(c.req.param("id"));
    return c.json({ history: store.history(c.req.param("id")) });
  });

  /** The live waveform selection (the web client sends it as it changes), so outside agents see it too. */
  app.put("/api/projects/:id/selection", async (c) => {
    const b = await c.req.json();
    const id = c.req.param("id");
    studio.project(id);
    return c.json({ selection: studio.setSelection(id, selectionFrom(b?.selection)) });
  });

  // --- the timeline: sounds layered on the song ----------------------------------------------

  app.get("/api/sounds", (c) => c.json({ sounds: SOUND_LIBRARY }));

  /** A library sound rendered on the spot, for listening before adding it. */
  app.get("/api/sounds/:sound/audio", (c) => {
    const sound = SOUND_LIBRARY.find((s) => s.id === c.req.param("sound"));
    if (!sound) throw new StudioError("not_found", "no such sound");
    const bpm = Number(c.req.query("bpm") ?? 100);
    const beatsPerBar = Number(c.req.query("beatsPerBar") ?? 4);
    if (!(bpm >= 40 && bpm <= 220) || ![2, 3, 4, 6].includes(beatsPerBar)) throw new StudioError("invalid", "bpm must be 40–220 and beatsPerBar one of 2, 3, 4, 6");
    const key = c.req.query("key") ?? "C Major";
    const audio = renderSound(sound.id, { bpm, key, beatsPerBar, sampleRate: 48000 });
    return c.body(new Uint8Array(encodeWav(audio)), 200, { "content-type": "audio/wav", "cache-control": "private, max-age=3600" });
  });

  app.post("/api/projects/:id/arrangement/:direction", (c) => {
    const direction = c.req.param("direction");
    if (direction !== "undo" && direction !== "redo") throw new StudioError("invalid", "use undo or redo");
    return c.json({ timeline: studio.arrangementStep(c.req.param("id"), direction) });
  });
  app.put("/api/projects/:id/music", async (c) => c.json({ timeline: studio.setMusic(c.req.param("id"), await c.req.json()) }));
  app.put("/api/projects/:id/lyrics", async (c) => {
    studio.saveLyrics(c.req.param("id"), (await c.req.json())?.lyrics);
    return c.json({ saved: true });
  });
  app.post("/api/projects/:id/takes/:takeId/joins", async (c) => c.json({ take: studio.refineJoins(c.req.param("id"), c.req.param("takeId"), await c.req.json()) }, 201));

  app.get("/api/projects/:id/timeline", (c) => c.json({ timeline: studio.timeline(c.req.param("id")) }));

  app.post("/api/projects/:id/clips", async (c) => {
    const b = await c.req.json();
    const r = studio.addSound(c.req.param("id"), {
      sound: b?.sound,
      startSec: b?.startSec,
      endSec: b?.endSec,
      trackId: b?.trackId,
      newTrack: b?.newTrack === true,
      gainDb: b?.gainDb,
      snap: b?.snap === true,
    });
    return c.json(r, 201);
  });

  /** Body: a 16-bit PCM WAV. Query: name, startSec?, trackId? */
  app.post("/api/projects/:id/clips/import", async (c) => {
    const wav = Buffer.from(await c.req.arrayBuffer());
    if (wav.length > 150_000_000) throw new StudioError("invalid", "the audio file is too large (the limit is 150 MB)");
    const startSec = c.req.query("startSec");
    const r = studio.importSound(c.req.param("id"), {
      name: c.req.query("name") ?? "Audio",
      wav,
      startSec: startSec === undefined ? undefined : Number(startSec),
      trackId: c.req.query("trackId") || undefined,
    });
    return c.json(r, 201);
  });

  app.patch("/api/projects/:id/clips/:clipId", async (c) => {
    const b = await c.req.json();
    const r = studio.updateClip(c.req.param("id"), c.req.param("clipId"), {
      startSec: b?.startSec,
      endSec: b?.endSec,
      durationSec: b?.durationSec,
      trackId: b?.trackId,
      newTrack: b?.newTrack === true,
      gainDb: b?.gainDb,
      snap: b?.snap === true,
    });
    return c.json(r);
  });

  app.delete("/api/projects/:id/clips/:clipId", (c) => c.json({ timeline: studio.removeClip(c.req.param("id"), c.req.param("clipId")) }));

  app.patch("/api/projects/:id/tracks/:trackId", async (c) => {
    const b = await c.req.json();
    return c.json({ timeline: studio.updateTrack(c.req.param("id"), c.req.param("trackId"), { name: b?.name, muted: b?.muted, gainDb: b?.gainDb }) });
  });

  /** The audio of a clip: a file in the project's sounds/ folder. */
  app.get("/api/projects/:id/sounds/:file", async (c) => {
    studio.project(c.req.param("id"));
    const file = store.soundPath(c.req.param("id"), c.req.param("file"));
    if (!file || !existsSync(file)) throw new StudioError("not_found", "no such sound file");
    return c.body(new Uint8Array(await readFile(file)), 200, { "content-type": "audio/wav", "cache-control": "private, no-cache" });
  });

  /** A take with the timeline's sounds mixed in, as one WAV. */
  app.get("/api/projects/:id/takes/:takeId/mix", (c) => {
    const { audio, take } = studio.mix(c.req.param("id"), c.req.param("takeId"));
    const name = `${take.params.title || "song"} - take ${take.seq} mix`.replace(/[^\w .()-]+/g, "_");
    return c.body(new Uint8Array(encodeWav(audio)), 200, {
      "content-type": "audio/wav",
      "cache-control": "no-store",
      ...(c.req.query("download") !== undefined ? { "content-disposition": `attachment; filename="${name}.wav"` } : {}),
    });
  });

  app.get("/api/jobs/:id", (c) => {
    const job = store.getJob(c.req.param("id"));
    if (!job) throw new StudioError("not_found", "no such job");
    return c.json({ job, take: store.getTake(job.takeId) });
  });

  // --- audio -------------------------------------------------------------------------

  function finishedTake(id: string) {
    const take = store.getTake(id);
    const file = take?.status === "done" ? store.takeAudioPath(id) : null;
    if (!take || !file) throw new StudioError("not_found", "this take has no audio");
    return { take, file };
  }

  app.get("/api/takes/:id/audio", async (c) => {
    const { take, file } = finishedTake(c.req.param("id"));
    const size = (await stat(file)).size;
    const headers: Record<string, string> = {
      "content-type": "audio/wav",
      "accept-ranges": "bytes",
      // A take's audio never changes, so it can be cached for good.
      "cache-control": "private, max-age=31536000, immutable",
    };
    if (c.req.query("download") !== undefined) {
      const name = `${take.params.title || "song"} - take ${take.seq}`.replace(/[^\w .()-]+/g, "_");
      headers["content-disposition"] = `attachment; filename="${name}.wav"`;
    }
    const range = /^bytes=(\d*)-(\d*)$/.exec(c.req.header("range") ?? "");
    if (range && (range[1] || range[2])) {
      let start = range[1] ? Number(range[1]) : Math.max(0, size - Number(range[2]));
      let end = range[1] && range[2] ? Math.min(Number(range[2]), size - 1) : size - 1;
      if (start >= size || start > end) {
        return c.body(null, 416, { "content-range": `bytes */${size}` });
      }
      const body = Readable.toWeb(createReadStream(file, { start, end })) as ReadableStream;
      return c.body(body, 206, { ...headers, "content-range": `bytes ${start}-${end}/${size}`, "content-length": String(end - start + 1) });
    }
    return c.body(Readable.toWeb(createReadStream(file)) as ReadableStream, 200, { ...headers, "content-length": String(size) });
  });

  app.get("/api/takes/:id/peaks", async (c) => {
    const { take, file } = finishedTake(c.req.param("id"));
    const peaks = JSON.parse(await readFile(file.replace(/\.wav$/, ".peaks.json"), "utf8"));
    c.header("cache-control", "private, max-age=31536000, immutable");
    return c.json({ peaks, durationSec: take.durationSec });
  });

  // --- MCP (Streamable HTTP, stateless) ---------------------------------------------------

  app.post("/mcp", (c) => handleMcp(c, studio, APP_VERSION));
  app.get("/mcp", (c) => c.body(null, 405, { allow: "POST" }));
  app.delete("/mcp", (c) => c.body(null, 405, { allow: "POST" }));

  app.all("/api/*", (c) => c.json({ error: "No such API route.", code: "not_found" }, 404));

  // --- the built web client -------------------------------------------------------------

  const dist = path.join(APP_ROOT, "dist");
  const MIME: Record<string, string> = {
    ".html": "text/html; charset=utf-8",
    ".js": "text/javascript; charset=utf-8",
    ".css": "text/css; charset=utf-8",
    ".svg": "image/svg+xml",
    ".png": "image/png",
    ".ico": "image/x-icon",
    ".json": "application/json",
    ".woff2": "font/woff2",
    ".map": "application/json",
  };
  app.get("*", async (c) => {
    if (!existsSync(path.join(dist, "index.html"))) {
      return c.text("The web client has not been built yet. Run `npm run build` (or use `npm run dev`).", 503);
    }
    // Serve a file from dist/ if the path names one; anything else gets the app shell.
    let file = path.join(dist, "index.html");
    try {
      const wanted = path.join(dist, decodeURIComponent(new URL(c.req.url).pathname));
      if (wanted.startsWith(dist + path.sep) && (await stat(wanted)).isFile()) file = wanted;
    } catch {
      /* not a file: fall through to index.html */
    }
    const hashed = file.startsWith(path.join(dist, "assets") + path.sep);
    return c.body(new Uint8Array(await readFile(file)), 200, {
      "content-type": MIME[path.extname(file)] ?? "application/octet-stream",
      "cache-control": hashed ? "public, max-age=31536000, immutable" : "no-cache",
    });
  });

  let server: ReturnType<typeof serve> | null = null;

  return {
    hono: app,
    config,
    store,
    bus,
    queue,
    studio,
    agent,
    llm,
    async start() {
      const recovered = await queue.recover();
      if (recovered.failed) console.log(`[queue] ${recovered.failed} job(s) were running when the app last stopped; marked as failed`);
      if (recovered.requeued) console.log(`[queue] resuming ${recovered.requeued} queued job(s)`);
      queue.kick();
      return new Promise((resolve, reject) => {
        server = serve({ fetch: app.fetch, port: config.port, hostname: config.host }, (info) => {
          const shown = config.host === "0.0.0.0" || config.host === "::" ? "localhost" : config.host;
          resolve({ url: `http://${shown}:${info.port}`, port: info.port });
        });
        server.on("error", reject);
      });
    },
    async close() {
      closing = true;
      queue.stop();
      for (const end of [...liveStreams]) end();
      const s = server;
      if (s) {
        await new Promise<void>((done) => {
          (s as any).closeAllConnections?.();
          s.close(() => done());
        });
      }
      store.close();
    },
  };
}
