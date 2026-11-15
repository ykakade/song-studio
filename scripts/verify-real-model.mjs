// Runs one generate and one repaint against the REAL ACE-Step server, through
// the app's own HTTP API (the same code path the agent's tools use), and prints
// timings and the splice check. No LLM and no browser are involved.
//
// Prerequisite: the model server is running (scripts/start-model-server.sh).
// Usage:  node scripts/verify-real-model.mjs
//
// The project it creates ("Real model check") is stored in the app's normal
// data folder, so you can open the app afterwards and listen to both takes.

import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { compareOutside } from "../server/splice.ts";
import { readWavFile } from "../server/wav.ts";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const PORT = Number(process.env.VERIFY_PORT ?? 18788);
const URL_ = `http://127.0.0.1:${PORT}`;
const ACESTEP_URL = process.env.ACESTEP_URL ?? "http://127.0.0.1:8001";
const DATA_DIR = path.resolve(ROOT, process.env.SONG_STUDIO_DATA_DIR ?? "data");

const SONG = {
  title: "Real model check",
  stylePrompt: "warm indie folk, fingerpicked acoustic guitar, soft brushed drums, intimate female vocal, close and dry",
  lyrics:
    "[verse]\nPaper boats along the gutter stream\nCarrying the light of a half-remembered dream\n\n[chorus]\nHold on, hold on, the morning's on its way\nHold on, hold on, we'll sing the dark away\n\n[outro]\nHold on, hold on",
  bpm: 96,
  key: "G Major",
  durationSec: 30,
  seed: 4242,
};
const REPAINT = {
  startSec: 12,
  endSec: 22,
  seed: 5151,
  lyrics: SONG.lyrics.replace(
    "Hold on, hold on, the morning's on its way\nHold on, hold on, we'll sing the dark away",
    "Sail on, sail on, the river knows the way\nSail on, sail on, we'll meet the sea by day",
  ),
  changeSummary: "New chorus words (real model check)",
};

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function api(method, p, body) {
  const res = await fetch(URL_ + p, { method, headers: body ? { "content-type": "application/json" } : {}, body: body ? JSON.stringify(body) : undefined });
  const json = await res.json();
  if (!res.ok) throw new Error(`${method} ${p} -> ${res.status}: ${json.error}`);
  return json;
}

async function waitForJob(jobId, label) {
  const t0 = Date.now();
  let lastStage = "";
  for (;;) {
    const { job, take } = await api("GET", `/api/jobs/${jobId}`);
    if (job.stage && job.stage !== lastStage) {
      lastStage = job.stage;
      console.log(`   [${label}] ${((Date.now() - t0) / 1000).toFixed(0).padStart(3)} s  ${Math.round(job.progress * 100)}%  ${job.stage}`);
    }
    if (job.status === "done") return { job, take };
    if (job.status === "failed") throw new Error(`${label} failed: ${job.error}`);
    await sleep(1000);
  }
}

const health = await fetch(`${ACESTEP_URL}/health`).then((r) => r.json()).catch(() => null);
if (health?.data?.status !== "ok") {
  console.error(`The model server is not answering at ${ACESTEP_URL}. Start it with scripts/start-model-server.sh and wait for it to load.`);
  process.exit(2);
}
console.log(`Model server: ${ACESTEP_URL} (${health.data.loaded_model}, models initialised: ${health.data.models_initialized})`);

const server = spawn(process.execPath, ["server/index.ts"], {
  cwd: ROOT,
  env: { ...process.env, HOST: "127.0.0.1", PORT: String(PORT), ACESTEP_URL, SONG_STUDIO_LLM: "fake", SONG_STUDIO_DATA_DIR: DATA_DIR, SONG_STUDIO_KEEP_RAW: "1" },
  stdio: ["ignore", "inherit", "inherit"],
});

let exitCode = 0;
try {
  for (let i = 0; i < 100; i++) {
    if (await fetch(`${URL_}/api/health`).then((r) => r.ok).catch(() => false)) break;
    await sleep(100);
  }
  const { project } = await api("POST", "/api/projects", { title: "Real model check" });

  console.log(`\n1. Generate a ${SONG.durationSec} s song`);
  const g0 = Date.now();
  const gen = await api("POST", `/api/projects/${project.id}/generate`, SONG);
  const g = await waitForJob(gen.job.id, "generate");
  console.log(`   done in ${((Date.now() - g0) / 1000).toFixed(1)} s wall clock; timings (ms): ${JSON.stringify(g.job.timings)}`);
  console.log(`   take ${g.take.id}: ${g.take.durationSec} s, ${g.take.sampleRate} Hz`);

  console.log(`\n2. Repaint ${REPAINT.startSec}–${REPAINT.endSec} s of that take`);
  const r0 = Date.now();
  const rep = await api("POST", `/api/projects/${project.id}/repaint`, { takeId: g.take.id, ...REPAINT });
  const r = await waitForJob(rep.job.id, "repaint");
  console.log(`   done in ${((Date.now() - r0) / 1000).toFixed(1)} s wall clock; timings (ms): ${JSON.stringify(r.job.timings)}`);
  console.log(`   take ${r.take.id}: parent ${r.take.parentTakeId}, ${r.take.durationSec} s`);
  console.log(`\n3. Splice check stored on the take:\n${JSON.stringify(r.take.checks, null, 2)}`);

  // Independent re-check from the files on disk (not trusting the stored numbers).
  const projectsDir = process.env.SONG_STUDIO_PROJECTS_DIR ? path.resolve(ROOT, process.env.SONG_STUDIO_PROJECTS_DIR) : path.join(DATA_DIR, "projects");
  const audio = (id, suffix = "") => {
    const take = id === g.take.id ? g.take : r.take;
    return path.join(projectsDir, project.id, "takes", `take-${String(take.seq).padStart(3, "0")}${suffix}.wav`);
  };
  const parent = await readWavFile(audio(g.take.id));
  const child = await readWavFile(audio(r.take.id));
  const raw = await readWavFile(audio(r.take.id, ".model-output"));
  const s = Math.round(REPAINT.startSec * parent.sampleRate);
  const e = Math.round(REPAINT.endSec * parent.sampleRate);
  const mine = compareOutside(child, parent, s, e);
  const theirs = compareOutside(raw, parent, s, e);
  let inside = 0;
  for (let i = s * parent.channels; i < e * parent.channels; i++) if (child.samples[i] !== parent.samples[i]) inside++;
  console.log(`\n4. Re-check from the WAV files on disk:`);
  console.log(`   app take vs parent, outside the range:      ${mine.mismatches} of ${mine.compared} samples differ`);
  console.log(`   model's own file vs parent, outside range:  ${theirs.mismatches} of ${theirs.compared} samples differ`);
  console.log(`   app take vs parent, inside the range:       ${inside} of ${(e - s) * parent.channels} samples differ`);
  console.log(`\nFiles: ${audio(g.take.id)}\n       ${audio(r.take.id)}\n       ${audio(r.take.id, ".model-output")} (what the model returned, kept for comparison)`);
  if (mine.mismatches !== 0 || r.take.checks.status !== "verified") {
    console.error("\nRESULT: the splice guarantee was NOT verified for this take.");
    exitCode = 1;
  } else {
    console.log("\nRESULT: verified. Outside the repainted range the new take is bit-identical to its parent.");
  }
} catch (err) {
  console.error(`\nFAILED: ${err.message}`);
  exitCode = 1;
} finally {
  server.kill("SIGINT");
  await new Promise((r) => server.once("exit", r));
}
process.exit(exitCode);
