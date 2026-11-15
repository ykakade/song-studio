import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { AceStepClient, AceStepError, buildGenerateBody, buildRepaintFields, type AceTaskState } from "../server/acestep.ts";
import { createMockAceStep, type MockAceStep } from "../server/mock-acestep.ts";
import { compareOutside, estimateOutsideGain } from "../server/splice.ts";
import { decodeWav, readWavFile } from "../server/wav.ts";
import { FIXTURES, sleep } from "./helpers.ts";

let mock: MockAceStep;
let server: { url: string; close(): Promise<void> };
let client: AceStepClient;
let tmp: string;

const song = {
  stylePrompt: "warm indie folk, fingerpicked acoustic guitar",
  lyrics: "[verse]\nOne line\n\n[chorus]\nAnother line",
  bpm: 96,
  key: "G Major",
  timeSignature: "4",
  vocalLanguage: "en",
  seed: 1234,
};

before(async () => {
  mock = createMockAceStep({ delayMs: 120 });
  server = await mock.listen(0);
  client = new AceStepClient(server.url + "/"); // trailing slash must not matter
  tmp = await mkdtemp(path.join(os.tmpdir(), "song-studio-test-"));
});

after(async () => {
  await server.close();
  await rm(tmp, { recursive: true, force: true });
});

async function waitDone(taskId: string): Promise<AceTaskState> {
  for (let i = 0; i < 200; i++) {
    const s = await client.query(taskId);
    if (s.state !== "running") return s;
    await sleep(20);
  }
  throw new Error("mock task did not finish");
}

test("acestep: request bodies carry every field the spike found necessary", () => {
  const gen = buildGenerateBody({ ...song, durationSec: 30 });
  assert.deepEqual(gen, {
    prompt: song.stylePrompt,
    lyrics: song.lyrics,
    bpm: 96,
    key_scale: "G Major",
    time_signature: "4",
    vocal_language: "en",
    seed: 1234,
    inference_steps: 8,
    use_random_seed: false,
    batch_size: 1,
    thinking: true,
    use_cot_caption: false,
    use_cot_language: false,
    audio_format: "wav",
    task_type: "text2music",
    audio_duration: 30,
  });
  // The LM planner can be switched off; repaint never uses it (the server skips it there anyway).
  assert.equal(buildGenerateBody({ ...song, durationSec: 30 }, false).thinking, false);
  const rep = buildRepaintFields({ ...song, startSec: 4, endSec: 9.5, srcAudioPath: "/x.wav" });
  assert.equal(rep.thinking, false);
  assert.equal(rep.task_type, "repaint");
  assert.equal(rep.repainting_start, 4);
  assert.equal(rep.repainting_end, 9.5);
  assert.equal(rep.chunk_mask_mode, "explicit");
  assert.equal(rep.audio_format, "wav");
  assert.equal(rep.batch_size, 1);
  assert.ok(!("audio_duration" in rep), "repaint must not send audio_duration");
  assert.ok(!("src_audio_path" in rep), "the source audio goes as an upload, never as a path");
});

test("acestep: health reports ok for a live server and a clear error for a dead one", async () => {
  const h = await client.health();
  assert.equal(h.ok, true);
  assert.equal(h.modelsInitialized, true);
  const dead = await new AceStepClient("http://127.0.0.1:9").health(500);
  assert.equal(dead.ok, false);
  assert.match(dead.error!, /cannot reach the model server/);
});

test("acestep: generate -> poll (progress) -> download gives a WAV of the requested length", async () => {
  const id = await client.submitGenerate({ ...song, durationSec: 5 });
  const first = await client.query(id);
  assert.equal(first.state, "running");
  assert.equal(typeof first.progress, "number");
  assert.equal(typeof first.stage, "string");
  const done = await waitDone(id);
  assert.equal(done.state, "done");
  assert.equal(done.audioCount, 1, "batch_size 1 must give exactly one audio");
  assert.match(done.file!, /^\/v1\/audio\?path=/);
  const dest = path.join(tmp, "gen.wav");
  await client.downloadAudio(done.file!, dest);
  const audio = await readWavFile(dest);
  assert.equal(audio.sampleRate, 48000);
  assert.equal(audio.channels, 2);
  assert.equal(audio.samples.length / 2, 5 * 48000);

  const sent = mock.requests.at(-1)!;
  assert.match(sent.contentType, /application\/json/);
  assert.equal(sent.fields.audio_format, "wav");
  assert.equal(sent.fields.batch_size, "1");
});

test("acestep: the same body and seed give a byte-identical file", async () => {
  const a = await waitDone(await client.submitGenerate({ ...song, durationSec: 3 }));
  const b = await waitDone(await client.submitGenerate({ ...song, durationSec: 3 }));
  const c = await waitDone(await client.submitGenerate({ ...song, durationSec: 3, seed: 999 }));
  await client.downloadAudio(a.file!, path.join(tmp, "a.wav"));
  await client.downloadAudio(b.file!, path.join(tmp, "b.wav"));
  await client.downloadAudio(c.file!, path.join(tmp, "c.wav"));
  const [fa, fb, fc] = await Promise.all(["a.wav", "b.wav", "c.wav"].map((f) => readFile(path.join(tmp, f))));
  assert.ok(fa.equals(fb));
  assert.ok(!fa.equals(fc));
});

test("acestep: repaint uploads the source as multipart src_audio and the result behaves like the real model's", async () => {
  const src = path.join(FIXTURES, "folk_orig_16s.wav");
  const id = await client.submitRepaint({ ...song, seed: 3, startSec: 4, endSec: 9, srcAudioPath: src });
  const sent = mock.requests.at(-1)!;
  assert.match(sent.contentType, /multipart\/form-data/);
  assert.equal(sent.hadUpload, true);
  assert.equal(sent.fields.task_type, "repaint");
  assert.equal(sent.fields.repainting_start, "4");
  assert.equal(sent.fields.repainting_end, "9");
  assert.equal(sent.fields.chunk_mask_mode, "explicit");
  assert.equal(sent.fields.lyrics, song.lyrics);
  assert.equal(sent.fields.use_random_seed, "false");
  assert.equal(sent.fields.src_audio_path, undefined);
  assert.equal(sent.fields.audio_duration, undefined);

  const done = await waitDone(id);
  assert.equal(done.state, "done");
  const dest = path.join(tmp, "rep.wav");
  await client.downloadAudio(done.file!, dest);
  const parent = await readWavFile(src);
  const result = await readWavFile(dest);
  assert.equal(result.samples.length, parent.samples.length);
  // Same length, same audio outside up to one uniform gain (seed 3 -> -0.4 dB), different inside.
  const est = estimateOutsideGain(parent, result, 4 * 48000, 9 * 48000, 12000)!;
  assert.ok(Math.abs(20 * Math.log10(est.gain) - -0.4) < 0.01);
  assert.ok(est.correlation > 0.999999);
  assert.ok(compareOutside(parent, result, 4 * 48000, 9 * 48000).mismatches > 100000);
});

test("acestep: a finished job with an empty file (mp3 without ffmpeg) is reported as a failure with the log line", async () => {
  // Bypass the client to send what a naive caller would: no audio_format.
  const res = await fetch(server.url + "/release_task", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ prompt: "x", lyrics: "[Instrumental]", audio_duration: 2, batch_size: 1 }),
  });
  const id = ((await res.json()) as any).data.task_id;
  const done = await waitDone(id);
  assert.equal(done.state, "failed");
  assert.match(done.error!, /produced no audio file/);
  assert.match(done.error!, /ffmpeg/);
});

test("acestep: the mock mirrors the batch_size default of 2", async () => {
  const res = await fetch(server.url + "/release_task", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ prompt: "x", lyrics: "[Instrumental]", audio_duration: 2, audio_format: "wav" }),
  });
  const done = await waitDone(((await res.json()) as any).data.task_id);
  assert.equal(done.audioCount, 2);
});

test("acestep: a failed job (status 2) surfaces its error", async () => {
  const id = await client.submitGenerate({ ...song, stylePrompt: "anything [mock:fail]", durationSec: 2 });
  const done = await waitDone(id);
  assert.equal(done.state, "failed");
  assert.match(done.error!, /mock failure/);
});

test("acestep: HTTP errors carry the server's detail message", async () => {
  // The quirk itself: absolute src_audio_path is a 400.
  const res = await fetch(server.url + "/release_task", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ task_type: "repaint", src_audio_path: "/abs/path.wav" }),
  });
  assert.equal(res.status, 400);
  assert.deepEqual(await res.json(), { detail: "absolute audio file paths are not allowed" });

  // And how the client reports a 400.
  const notWav = path.join(tmp, "not.wav");
  await (await import("node:fs/promises")).writeFile(notWav, "garbage");
  await assert.rejects(
    client.submitRepaint({ ...song, startSec: 1, endSec: 2, srcAudioPath: notWav }),
    (err: unknown) => err instanceof AceStepError && err.kind === "http" && err.status === 400 && /cannot read src_audio/.test(err.message),
  );
});

test("acestep: an unreachable server raises AceStepError(unreachable)", async () => {
  const dead = new AceStepClient("http://127.0.0.1:9");
  await assert.rejects(dead.submitGenerate({ ...song, durationSec: 2 }), (err: unknown) => err instanceof AceStepError && err.kind === "unreachable");
});

test("acestep: the mock's audio endpoint only serves its own files", async () => {
  const res = await fetch(server.url + "/v1/audio?path=" + encodeURIComponent("/etc/hosts"));
  assert.equal(res.status, 404);
  assert.equal(decodeWav(await readFile(path.join(FIXTURES, "folk_orig_16s.wav"))).channels, 2);
});
