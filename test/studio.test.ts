// Data model + job queue + takes + splice, through the real service code,
// against the mock ACE-Step server.

import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import { compareOutside } from "../server/splice.ts";
import { StudioError } from "../server/studio.ts";
import { readWavFile } from "../server/wav.ts";
import { waitFor } from "./helpers.ts";
import { SONG, startHarness } from "./harness.ts";

const sha = async (file: string) => createHash("sha256").update(await readFile(file)).digest("hex");

test("studio: generate creates a parentless take, stores its audio and makes it current", async () => {
  const h = await startHarness();
  try {
    const project = h.app.studio.createProject();
    assert.equal(project.title, "Untitled song");
    const { job, take, queuePosition } = await h.app.studio.startGenerate(project.id, { ...SONG, seed: 42 });
    assert.equal(job.status, "queued");
    assert.equal(take.status, "queued");
    assert.equal(take.parentTakeId, null);
    assert.equal(take.rootTakeId, take.id);
    assert.equal(queuePosition, 1);
    await h.settle();

    const done = h.app.store.getTake(take.id)!;
    assert.equal(done.status, "done");
    assert.equal(done.kind, "generate");
    assert.equal(done.seq, 1);
    assert.equal(done.durationSec, 12);
    assert.equal(done.sampleRate, 48000);
    assert.equal(done.checks, null);
    assert.deepEqual(done.params, {
      title: "Paper Boats",
      stylePrompt: SONG.stylePrompt,
      lyrics: SONG.lyrics,
      bpm: 96,
      key: "G Major",
      timeSignature: "4",
      vocalLanguage: "en",
      durationSec: 12,
      seed: 42,
      repaint: null,
    });
    const p = h.app.store.getProject(project.id)!;
    assert.equal(p.currentTakeId, take.id);
    assert.equal(p.title, "Paper Boats", "an untitled project takes the song's title");

    const file = h.app.store.takeAudioPath(take.id)!;
    assert.equal((await readWavFile(file)).samples.length, 12 * 48000 * 2);
    const peaks = JSON.parse(await readFile(h.app.store.takePath(take, ".peaks.json"), "utf8"));
    assert.equal(peaks.length, 2400);
    assert.deepEqual(await readdir(path.join(h.dataDir, "tmp")), [], "no temp files left behind");

    const finished = h.app.store.getJob(job.id)!;
    assert.equal(finished.status, "done");
    assert.equal(finished.progress, 1);
    assert.ok(finished.timings.modelMs! >= 50);
    assert.ok(finished.timings.totalMs! >= finished.timings.modelMs!);

    const notes = h.app.store.listMessages(project.id).filter((m) => m.role === "event");
    assert.equal(notes.length, 1);
    assert.match((notes[0] as any).text, /Take 1 is ready/);

    // What ACE-Step was actually asked for.
    const sent = h.mock.requests.at(-1)!.fields;
    assert.equal(sent.task_type, "text2music");
    assert.equal(sent.audio_duration, "12");
    assert.equal(sent.seed, "42");
    assert.equal(sent.audio_format, "wav");
  } finally {
    await h.stop();
  }
});

test("studio: repaint creates a child take that is bit-identical to its parent outside the range, and never touches the parent", async () => {
  const h = await startHarness();
  try {
    const project = h.app.studio.createProject("Demo");
    const gen = await h.app.studio.startGenerate(project.id, { ...SONG, seed: 1 });
    await h.settle();
    const parentFile = h.app.store.takeAudioPath(gen.take.id)!;
    const parentHash = await sha(parentFile);

    const newLyrics = SONG.lyrics.replace("Hold on, hold on", "Sail on, sail on");
    const rep = await h.app.studio.startRepaint(project.id, {
      takeId: gen.take.id,
      startSec: 4,
      endSec: 8.5,
      lyrics: newLyrics,
      seed: 3, // the mock turns the whole file down by 0.4 dB for seed 3
      changeSummary: "New chorus words",
    });
    assert.equal(rep.take.parentTakeId, gen.take.id);
    assert.equal(rep.take.rootTakeId, gen.take.id);
    assert.equal(rep.take.kind, "repaint");
    await h.settle();

    const take = h.app.store.getTake(rep.take.id)!;
    assert.equal(take.status, "done");
    assert.equal(take.seq, 2);
    assert.equal(take.durationSec, 12, "repaint never changes the length");
    assert.equal(take.changeSummary, "New chorus words");
    assert.deepEqual(take.params.repaint, { startSec: 4, endSec: 8.5 });
    assert.equal(take.params.lyrics, newLyrics);
    assert.equal(take.params.stylePrompt, SONG.stylePrompt, "style is inherited when not given");
    assert.equal(take.params.bpm, 96);

    const c = take.checks!;
    assert.equal(c.status, "verified");
    assert.equal(c.bitIdenticalOutside, true);
    assert.equal(c.outsideMismatches, 0);
    assert.equal(c.outsideSamples, (12 - 4.5) * 48000 * 2);
    assert.ok(Math.abs(c.gainDb! - -0.4) < 0.01, `gainDb ${c.gainDb}`);
    assert.ok(c.correlation! > 0.999999);
    assert.equal(c.boundaries.length, 2);
    assert.equal(c.crossfadeMs, 50);

    // Independent check on the files themselves.
    const parent = await readWavFile(parentFile);
    const child = await readWavFile(h.app.store.takeAudioPath(take.id)!);
    assert.equal(compareOutside(child, parent, 4 * 48000, 8.5 * 48000).mismatches, 0);
    let insideDiff = 0;
    for (let i = 5 * 48000 * 2; i < 8 * 48000 * 2; i++) if (child.samples[i] !== parent.samples[i]) insideDiff++;
    assert.ok(insideDiff > 100000, "the range itself was regenerated");
    assert.equal(await sha(parentFile), parentHash, "the parent take's file is untouched");
    assert.deepEqual(h.app.store.getTake(gen.take.id)!.params.lyrics, SONG.lyrics, "the parent take's record is untouched");

    assert.equal(h.app.store.getProject(project.id)!.currentTakeId, take.id);
    const note = h.app.store.listMessages(project.id).at(-1) as any;
    assert.match(note.text, /Take 2 is ready\. Verified: everything outside 4\.00–8\.50 s is bit-identical/);

    // The request: multipart upload of the parent, full lyrics, explicit mask, no duration.
    const sent = h.mock.requests.at(-1)!;
    assert.equal(sent.hadUpload, true);
    assert.equal(sent.fields.task_type, "repaint");
    assert.equal(sent.fields.repainting_start, "4");
    assert.equal(sent.fields.repainting_end, "8.5");
    assert.equal(sent.fields.lyrics, newLyrics);
    assert.equal(sent.fields.audio_duration, undefined);
  } finally {
    await h.stop();
  }
});

test("studio (chained): repaint of a repaint of a repaint, through the whole pipeline, does not drift", async () => {
  const h = await startHarness();
  try {
    const project = h.app.studio.createProject("Chain");
    const t1 = (await h.app.studio.startGenerate(project.id, { ...SONG, durationSec: 20, seed: 5 })).take;
    await h.settle();
    const ranges: Array<[number, number, number]> = [
      [3, 6, 4], // start, end, seed (seed picks the mock's gain: -0.5, -0.2, -0.3 dB)
      [10, 13.25, 1],
      [5, 7.5, 2],
    ];
    let parentId = t1.id;
    for (const [startSec, endSec, seed] of ranges) {
      const r = await h.app.studio.startRepaint(project.id, { takeId: parentId, startSec, endSec, lyrics: SONG.lyrics, seed });
      await h.settle();
      const t = h.app.store.getTake(r.take.id)!;
      assert.equal(t.status, "done");
      assert.equal(t.checks!.status, "verified");
      assert.equal(t.checks!.bitIdenticalOutside, true);
      assert.equal(t.parentTakeId, parentId);
      assert.equal(t.rootTakeId, t1.id);
      parentId = t.id;
    }
    const first = await readWavFile(h.app.store.takeAudioPath(t1.id)!);
    const last = await readWavFile(h.app.store.takeAudioPath(parentId)!);
    let compared = 0;
    let differs = 0;
    for (let f = 0; f < 20 * 48000; f++) {
      const t = f / 48000;
      if (ranges.some(([s, e]) => t >= s && t < e)) continue;
      compared += 2;
      if (first.samples[f * 2] !== last.samples[f * 2]) differs++;
      if (first.samples[f * 2 + 1] !== last.samples[f * 2 + 1]) differs++;
    }
    assert.equal(compared, (20 - 3 - 3.25 - 1.5) * 48000 * 2);
    assert.equal(differs, 0, "take 4 differs from take 1 outside every repainted range");
    assert.deepEqual(h.takes(project.id).map((t) => [t.seq, t.kind, t.status]), [
      [1, "generate", "done"],
      [2, "repaint", "done"],
      [3, "repaint", "done"],
      [4, "repaint", "done"],
    ]);
  } finally {
    await h.stop();
  }
});

test("studio: when the model's output does not line up with the parent, the take falls back and says the guarantee was not verified", async () => {
  const h = await startHarness();
  try {
    const project = h.app.studio.createProject("Fallback");
    const gen = await h.app.studio.startGenerate(project.id, SONG);
    await h.settle();
    const rep = await h.app.studio.startRepaint(project.id, {
      takeId: gen.take.id,
      startSec: 2,
      endSec: 6,
      lyrics: SONG.lyrics,
      stylePrompt: `${SONG.stylePrompt} [mock:regen]`,
    });
    await h.settle();
    const take = h.app.store.getTake(rep.take.id)!;
    assert.equal(take.status, "done");
    assert.equal(take.checks!.status, "fallback");
    assert.equal(take.checks!.bitIdenticalOutside, false);
    assert.match(take.checks!.reason!, /does not match the parent/);
    assert.match((h.app.store.listMessages(project.id).at(-1) as any).text, /NOT verified/);
  } finally {
    await h.stop();
  }
});

test("studio: a failed job fails its take, keeps the current take, and tells the user why", async () => {
  const h = await startHarness();
  try {
    const project = h.app.studio.createProject("Fail");
    const good = await h.app.studio.startGenerate(project.id, SONG);
    await h.settle();
    const bad = await h.app.studio.startGenerate(project.id, { ...SONG, stylePrompt: "anything [mock:fail]" });
    await h.settle();
    const take = h.app.store.getTake(bad.take.id)!;
    assert.equal(take.status, "failed");
    assert.match(take.error!, /mock failure/);
    assert.equal(h.app.store.getJob(bad.job.id)!.status, "failed");
    assert.equal(h.app.store.getProject(project.id)!.currentTakeId, good.take.id);
    assert.equal(h.app.store.takeAudioPath(take.id), null);
    assert.equal(existsSync(h.app.store.takePath(take, ".wav")), false);
    const note = h.app.store.listMessages(project.id).at(-1) as any;
    assert.equal(note.kind, "take_failed");
    assert.match(note.text, /Take 2 failed: .*mock failure/);
    // A failed take cannot be repainted or made current.
    await assert.rejects(h.app.studio.startRepaint(project.id, { takeId: take.id, startSec: 1, endSec: 3, lyrics: "x" }), StudioError);
    assert.throws(() => h.app.studio.setCurrentTake(project.id, take.id), StudioError);
  } finally {
    await h.stop();
  }
});

test("studio: jobs run strictly one at a time, in the order they were asked for", async () => {
  const h = await startHarness({ mockDelayMs: 80 });
  try {
    const a = h.app.studio.createProject("A");
    const b = h.app.studio.createProject("B");
    const r1 = await h.app.studio.startGenerate(a.id, SONG);
    const r2 = await h.app.studio.startGenerate(b.id, SONG);
    const r3 = await h.app.studio.startGenerate(a.id, SONG);
    assert.deepEqual([r1.queuePosition, r2.queuePosition, r3.queuePosition], [1, 2, 3]);
    assert.equal(h.app.store.listJobsByStatus(["queued", "running"]).length, 3);
    await h.settle();
    assert.equal(h.mock.stats.submitted, 3);
    assert.equal(h.mock.stats.maxConcurrent, 1, "never more than one job on the model server");
    const jobs = [r1, r2, r3].map((r) => h.app.store.getJob(r.job.id)!);
    for (const j of jobs) assert.equal(j.status, "done");
    assert.ok(jobs[0].finishedAt! <= jobs[1].startedAt!, "job 2 started after job 1 finished");
    assert.ok(jobs[1].finishedAt! <= jobs[2].startedAt!, "job 3 started after job 2 finished");
  } finally {
    await h.stop();
  }
});

test("studio: input is validated before anything is queued", async () => {
  const h = await startHarness();
  try {
    const project = h.app.studio.createProject("Validation");
    const bad = async (patch: object, re: RegExp) =>
      assert.rejects(h.app.studio.startGenerate(project.id, { ...SONG, ...patch } as any), (e: unknown) => e instanceof StudioError && e.code === "invalid" && re.test(e.message));
    await bad({ durationSec: 121 }, /over the current limit of 120/);
    await bad({ durationSec: 5 }, /at least 10/);
    await bad({ bpm: 500 }, /bpm must be between/);
    await bad({ lyrics: "   " }, /lyrics must be a non-empty string/);
    await bad({ timeSignature: "7" }, /time signature/);
    // 12 s at 96 bpm has room for 12 sung words; SONG has exactly 12.
    await bad({ lyrics: `${SONG.lyrics}\nOne more line` }, /15 sung words, but a 12 s song at 96 bpm has room for about 12/);
    await bad({ stylePrompt: undefined }, /style prompt/);
    assert.equal(h.takes(project.id).length, 0);
    assert.equal(h.mock.stats.submitted, 0);

    const gen = await h.app.studio.startGenerate(project.id, SONG);
    // Not finished yet -> cannot be repainted.
    await assert.rejects(h.app.studio.startRepaint(project.id, { takeId: gen.take.id, startSec: 1, endSec: 3, lyrics: "x" }), /only a finished take can be repainted/);
    await h.settle();
    const rep = (patch: object) => h.app.studio.startRepaint(project.id, { takeId: gen.take.id, startSec: 1, endSec: 3, lyrics: SONG.lyrics, ...patch });
    await assert.rejects(rep({ endSec: 30 }), /outside the song/);
    await assert.rejects(rep({ startSec: -2 }), /outside the song/);
    await assert.rejects(rep({ startSec: 2.9 }), /at least 0\.5 s/);
    await assert.rejects(rep({ startSec: 5, endSec: 2 }), /at least 0\.5 s/);
    await assert.rejects(rep({ lyrics: "" }), /lyrics/);
    await assert.rejects(rep({ lyrics: `${SONG.lyrics}\nOne more line` }), /would have 15 sung words/);
    await assert.rejects(rep({ takeId: "t_nope" }), (e: unknown) => e instanceof StudioError && e.code === "not_found");
    await assert.rejects(h.app.studio.startGenerate("p_nope", SONG), (e: unknown) => e instanceof StudioError && e.code === "not_found");
    assert.equal(h.takes(project.id).length, 1);

    // A selection that overshoots the end by a hair (drag to the edge) is snapped, not rejected.
    const ok = await rep({ startSec: 10, endSec: 12.1 });
    assert.deepEqual(ok.take.params.repaint, { startSec: 10, endSec: 12 });
    await h.settle();
    assert.equal(h.app.store.getTake(ok.take.id)!.checks!.boundaries.length, 1, "a range ending at the end of the song has one boundary");
  } finally {
    await h.stop();
  }
});

test("studio: nothing is queued when the model server is unreachable", async () => {
  const h = await startHarness({ modelServerDown: true });
  try {
    const project = h.app.studio.createProject("Down");
    await assert.rejects(
      h.app.studio.startGenerate(project.id, SONG),
      (e: unknown) => e instanceof StudioError && e.code === "model_server_unreachable" && /start-model-server\.sh/.test(e.message),
    );
    assert.equal(h.takes(project.id).length, 0);
    assert.equal(h.app.store.listJobsByStatus(["queued", "running", "failed"]).length, 0);
  } finally {
    await h.stop();
  }
});

test("studio: markers belong to the song (lineage), survive repaints, and come back on revert", async () => {
  const h = await startHarness();
  try {
    const project = h.app.studio.createProject("Markers");
    assert.throws(() => h.app.studio.setMarkers(project.id, [{ label: "chorus", startSec: 1, endSec: 2 }]), /no finished take/);
    const song1 = (await h.app.studio.startGenerate(project.id, SONG)).take;
    await h.settle();

    const saved = h.app.studio.setMarkers(project.id, [
      { label: "chorus", startSec: 6, endSec: 9 },
      { label: " verse 1 ", startSec: 0, endSec: 6 },
    ]);
    assert.deepEqual(saved, [
      { label: "verse 1", startSec: 0, endSec: 6 },
      { label: "chorus", startSec: 6, endSec: 9 },
    ]);
    assert.throws(() => h.app.studio.setMarkers(project.id, [{ label: "x", startSec: 5, endSec: 40 }]), /outside the song/);
    assert.throws(() => h.app.studio.setMarkers(project.id, [{ label: "x", startSec: 5, endSec: 5 }]), /must end after it starts/);
    assert.throws(
      () => h.app.studio.setMarkers(project.id, [{ label: "A", startSec: 1, endSec: 2 }, { label: "a", startSec: 3, endSec: 4 }]),
      /different names/,
    );
    assert.equal(h.app.studio.markers(project.id).length, 2, "a rejected update changes nothing");

    await h.app.studio.startRepaint(project.id, { takeId: song1.id, startSec: 6, endSec: 9, lyrics: SONG.lyrics });
    await h.settle();
    assert.equal(h.app.studio.markers(project.id).length, 2, "markers stay valid across a repaint");

    const song2 = (await h.app.studio.startGenerate(project.id, { ...SONG, title: "Another" })).take;
    await h.settle();
    assert.equal(h.app.store.getProject(project.id)!.currentTakeId, song2.id);
    assert.deepEqual(h.app.studio.markers(project.id), [], "a new song starts without the old song's markers");

    h.app.studio.setCurrentTake(project.id, song1.id);
    assert.equal(h.app.studio.markers(project.id).length, 2, "going back to the first song brings its markers back");
  } finally {
    await h.stop();
  }
});

test("studio: a job that was running when the app stopped is failed on restart; queued jobs then run", async () => {
  const first = await startHarness({ mockDelayMs: 600 });
  const project = first.app.studio.createProject("Restart");
  const running = await first.app.studio.startGenerate(project.id, SONG);
  const waiting = await first.app.studio.startGenerate(project.id, { ...SONG, title: "Second" });
  await waitFor(() => first.app.store.getJob(running.job.id)!.status === "running", 3000, "job to start");
  assert.equal(first.app.store.getJob(waiting.job.id)!.status, "queued");
  // Stop the app mid-job (the mock keeps running, like the real model server would).
  await first.stop({ keepData: true, keepMock: true });

  const second = await startHarness({ dataDir: first.dataDir, mock: { mock: first.mock, url: first.mockUrl, close: first.closeMock } });
  try {
    // start() already ran recover(): the interrupted job is failed, not left running forever.
    const failedJob = second.app.store.getJob(running.job.id)!;
    assert.equal(failedJob.status, "failed");
    assert.match(failedJob.error!, /stopped while this job was running/);
    assert.equal(second.app.store.getTake(running.take.id)!.status, "failed");
    assert.ok(second.app.store.listMessages(project.id).some((m) => m.role === "event" && /Take 1 failed/.test(m.text)));

    await second.settle();
    assert.equal(second.app.store.getJob(waiting.job.id)!.status, "done", "the job that was only queued ran after the restart");
    assert.equal(second.app.store.getTake(waiting.take.id)!.status, "done");
    assert.equal(second.app.store.getProject(project.id)!.currentTakeId, waiting.take.id);
    assert.equal(second.app.store.listJobsByStatus(["running", "queued"]).length, 0);
  } finally {
    await second.stop();
  }
});

test("http: project state, audio with Range, peaks, direct generate/repaint, errors", async () => {
  const h = await startHarness();
  try {
    const api = async (method: string, p: string, body?: unknown) => {
      const res = await fetch(h.url + p, { method, headers: body ? { "content-type": "application/json" } : {}, body: body ? JSON.stringify(body) : undefined });
      return { status: res.status, json: (await res.json()) as any };
    };
    const health = await api("GET", "/api/health");
    assert.equal(health.json.modelServer.reachable, true);
    assert.deepEqual(health.json.llm, { provider: "fake", model: "scripted-fake", ready: true, problem: null });

    const created = await api("POST", "/api/projects", { title: "Over HTTP" });
    assert.equal(created.status, 201);
    const id = created.json.project.id;

    const gen = await api("POST", `/api/projects/${id}/generate`, SONG);
    assert.equal(gen.status, 202);
    await h.settle();
    const rep = await api("POST", `/api/projects/${id}/repaint`, { takeId: gen.json.take.id, startSec: 3, endSec: 7, lyrics: SONG.lyrics, changeSummary: "via http" });
    assert.equal(rep.status, 202);
    await h.settle();

    const state = await api("GET", `/api/projects/${id}`);
    assert.equal(state.json.takes.length, 2);
    assert.equal(state.json.project.currentTakeId, rep.json.take.id);
    assert.equal(state.json.takes[1].checks.status, "verified");
    assert.equal(state.json.activeJobs.length, 0);
    assert.equal(state.json.chatBusy, false);
    const job = await api("GET", `/api/jobs/${rep.json.job.id}`);
    assert.equal(job.json.job.status, "done");
    assert.equal(job.json.take.checks.bitIdenticalOutside, true);

    const list = await api("GET", "/api/projects");
    assert.equal(list.json.projects[0].takeCount, 2);

    // Audio: whole file, then a byte range, then a download.
    const audioUrl = `${h.url}/api/takes/${rep.json.take.id}/audio`;
    const whole = await fetch(audioUrl);
    assert.equal(whole.status, 200);
    assert.equal(whole.headers.get("content-type"), "audio/wav");
    const bytes = Buffer.from(await whole.arrayBuffer());
    assert.equal(bytes.length, 44 + 12 * 48000 * 4);
    const part = await fetch(audioUrl, { headers: { range: "bytes=100-199" } });
    assert.equal(part.status, 206);
    assert.equal(part.headers.get("content-range"), `bytes 100-199/${bytes.length}`);
    assert.ok(Buffer.from(await part.arrayBuffer()).equals(bytes.subarray(100, 200)));
    const tail = await fetch(audioUrl, { headers: { range: "bytes=-10" } });
    assert.ok(Buffer.from(await tail.arrayBuffer()).equals(bytes.subarray(bytes.length - 10)));
    assert.equal((await fetch(audioUrl, { headers: { range: `bytes=${bytes.length}-` } })).status, 416);
    const dl = await fetch(audioUrl + "?download");
    assert.match(dl.headers.get("content-disposition")!, /attachment; filename="Paper Boats - take 2\.wav"/);
    await dl.arrayBuffer();

    const peaks = await api("GET", `/api/takes/${rep.json.take.id}/peaks`);
    assert.equal(peaks.json.peaks.length, 2400);
    assert.equal(peaks.json.durationSec, 12);

    // Switching takes and markers.
    assert.equal((await api("POST", `/api/projects/${id}/current-take`, { takeId: gen.json.take.id })).status, 200);
    assert.equal((await api("GET", `/api/projects/${id}`)).json.project.currentTakeId, gen.json.take.id);
    const markers = await api("PUT", `/api/projects/${id}/markers`, { markers: [{ label: "chorus", startSec: 3, endSec: 7 }] });
    assert.deepEqual(markers.json.markers, [{ label: "chorus", startSec: 3, endSec: 7 }]);

    // Errors.
    assert.equal((await api("GET", "/api/projects/no-such-project")).status, 404);
    assert.equal((await api("GET", "/api/takes/t_missing/peaks")).status, 404);
    const tooLong = await api("POST", `/api/projects/${id}/generate`, { ...SONG, durationSec: 500 });
    assert.equal(tooLong.status, 400);
    assert.match(tooLong.json.error, /limit of 120/);
    assert.equal((await api("POST", `/api/projects/${id}/chat`, { text: "  " })).status, 400);
    assert.equal((await api("GET", "/api/nope")).status, 404);

    // Delete removes records and audio.
    assert.equal((await api("DELETE", `/api/projects/${id}`)).status, 200);
    assert.equal((await api("GET", `/api/projects/${id}`)).status, 404);
    assert.equal(existsSync(path.join(h.app.store.root, id)), false, "the project folder is gone");
  } finally {
    await h.stop();
  }
});
