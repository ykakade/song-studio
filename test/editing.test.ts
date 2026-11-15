import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { SONG, startHarness } from "./harness.ts";
import { ProjectStore } from "../server/store.ts";
import { compareOutside, spliceRepaint } from "../server/splice.ts";
import { renderSound } from "../server/sounds.ts";
import { decodeWav, encodeWav } from "../server/wav.ts";
import { executeTool, toolDefinitions } from "../server/agent/tools.ts";
import { synth } from "./helpers.ts";

async function setup() {
  const h = await startHarness();
  const p = h.app.studio.createProject();
  const { take } = await h.app.studio.startGenerate(p.id, SONG);
  await h.settle();
  return { h, p, take: h.app.store.getTake(take.id)! };
}

test("arrangement history restores removed files, track levels and positions, survives reload, and branches after undo", async () => {
  const { h, p, take } = await setup();
  try {
    const s = h.app.studio;
    const { clip } = s.addSound(p.id, { sound: "drums.backbeat", startSec: 0, endSec: 5 });
    s.updateClip(p.id, clip.id, { startSec: 3 });
    s.updateTrack(p.id, clip.trackId, { muted: true, gainDb: -8 });
    s.removeClip(p.id, clip.id);
    const fresh = new ProjectStore(h.app.store.root);
    assert.equal(fresh.arrangementHistory(p.id, take.id).past.length, 4);
    const restored = s.arrangementStep(p.id, "undo");
    assert.equal(restored.clips[0].startSec, 3);
    assert.equal(restored.tracks[0].muted, true);
    assert.equal(restored.tracks[0].gainDb, -8);
    assert.ok(readFileSync(h.app.store.soundPath(p.id, restored.clips[0].file)!));
    s.arrangementStep(p.id, "undo");
    assert.equal(s.timeline(p.id)!.tracks[0].muted, false);
    s.arrangementStep(p.id, "redo");
    assert.equal(s.timeline(p.id)!.tracks[0].muted, true);
    s.updateClip(p.id, clip.id, { gainDb: -3 });
    assert.equal(s.timeline(p.id)!.history.canRedo, false);
    assert.throws(() => s.arrangementStep(p.id, "redo"), /nothing to redo/);
    const result = await executeTool(s, p.id, toolDefinitions(120), "arrangement_history", { direction: "undo" });
    assert.equal(result.isError, false);
    assert.equal(s.timeline(p.id)!.clips[0].gainDb, 0);
  } finally {
    await h.stop();
  }
});

test("chord regions render the expected harmony at the clip's phase; tempo and chords undo together; imports stay intact", async () => {
  const { h, p, take } = await setup();
  try {
    const s = h.app.studio;
    const original = readFileSync(h.app.store.takeAudioPath(take.id)!);
    const guitar = s.addSound(p.id, { sound: "guitar.strum", startSec: 0, endSec: 12 }).clip;
    const imported = s.importSound(p.id, { name: "riff", wav: encodeWav(synth(2, 4)), startSec: 1 }).clip;
    const chords = [
      { chord: "C", startSec: 0, endSec: 6 },
      { chord: "Am", startSec: 6, endSec: 12 },
    ];
    const changed = s.setMusic(p.id, { bpm: 100, firstBeatSec: 0.25, chords });
    const fitted = changed.clips.find((c) => c.id === guitar.id)!;
    const audio = decodeWav(readFileSync(h.app.store.soundPath(p.id, fitted.file)!));
    const sr = take.sampleRate!;
    const c = renderSound("guitar.strum", { bpm: 100, key: "C", beatsPerBar: 4, sampleRate: sr });
    const am = renderSound("guitar.strum", { bpm: 100, key: "Am", beatsPerBar: 4, sampleRate: sr });
    const first = Math.round(0.2 * sr) * 2,
      second = Math.round(6.2 * sr) * 2;
    assert.deepEqual(audio.samples.slice(first, first + 100), c.samples.slice(first % c.samples.length, (first % c.samples.length) + 100));
    assert.deepEqual(
      audio.samples.slice(second, second + 100),
      am.samples.slice(second % am.samples.length, (second % am.samples.length) + 100),
    );
    assert.equal(changed.clips.find((c) => c.id === imported.id)!.file, imported.file);
    assert.equal(changed.grid.manual, true);
    assert.equal(changed.grid.firstBeatSec, 0.25);
    const undone = s.arrangementStep(p.id, "undo");
    assert.equal(undone.clips[0].file, guitar.file);
    assert.deepEqual(undone.chords, []);
    assert.equal(s.arrangementStep(p.id, "redo").clips[0].file, fitted.file);
    assert.deepEqual(readFileSync(h.app.store.takeAudioPath(take.id)!), original);
    assert.throws(
      () =>
        s.setMusic(p.id, {
          bpm: 100,
          firstBeatSec: 0,
          chords: [
            { chord: "Am", startSec: 0, endSec: 4 },
            { chord: "G", startSec: 3, endSec: 5 },
          ],
        }),
      /overlap/,
    );
    assert.throws(() => s.setMusic(p.id, { bpm: 100, firstBeatSec: 0, chords: [{ chord: "wat", startSec: 0, endSec: 4 }] }), /unsupported/);
  } finally {
    await h.stop();
  }
});

test("level matching reduces the edited section's level difference and preserves every outside sample", () => {
  const parent = synth(6, 12, { level: 0.18 });
  const edited = { ...parent, samples: parent.samples.slice() };
  const start = 2 * parent.sampleRate * parent.channels,
    end = 4 * parent.sampleRate * parent.channels;
  for (let i = start; i < end; i++) edited.samples[i] *= 1.8;
  const matched = spliceRepaint(parent, edited, { startSec: 2, endSec: 4, crossfadeMs: 0, matchLevel: true });
  assert.equal(compareOutside(matched.audio, parent, 2 * parent.sampleRate, 4 * parent.sampleRate).mismatches, 0);
  let error = 0;
  for (let i = start; i < end; i++) error += Math.abs(matched.audio.samples[i] - parent.samples[i]);
  assert.ok(error / (end - start) < 2, "level matching recovers the original level within quantisation error");
});

test("HTTP draft, undo and join endpoints validate inputs; join refinement creates an immutable verified child without model work", async () => {
  const { h, p, take } = await setup();
  const req = (route: string, method: string, body: unknown) =>
    h.app.hono.request(`/api/projects/${p.id}${route}`, {
      method,
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
  try {
    const lyrics = "[verse]\nA quiet road leads home";
    assert.equal((await req("/lyrics", "PUT", { lyrics })).status, 200);
    assert.equal(readFileSync(path.join(p.path, "lyrics.md"), "utf8"), lyrics);
    assert.equal(h.app.studio.snapshot(p.id).lyricsDraft, lyrics);
    assert.equal((await req("/lyrics", "PUT", { lyrics: 42 })).status, 400);
    assert.equal((await req("/arrangement/undo", "POST", {})).status, 409);
    assert.equal((await req(`/takes/${take.id}/joins`, "POST", { crossfadeMs: 100, matchLevel: true })).status, 400);
    const r = await h.app.studio.startRepaint(p.id, { takeId: take.id, startSec: 3, endSec: 6, lyrics: SONG.lyrics });
    await h.settle();
    const before = readFileSync(h.app.store.takeAudioPath(r.take.id)!);
    const jobs = h.app.store.listJobsByStatus(["done"]).length;
    assert.equal((await req(`/takes/${r.take.id}/joins`, "POST", { crossfadeMs: -1 })).status, 400);
    const response = await req(`/takes/${r.take.id}/joins`, "POST", { crossfadeMs: 120, matchLevel: true });
    assert.equal(response.status, 201);
    const refined = ((await response.json()) as { take: import("../server/types.ts").Take }).take;
    assert.equal(refined.parentTakeId, r.take.id);
    assert.ok(refined.checks);
    assert.equal(refined.checks.bitIdenticalOutside, true);
    assert.equal(refined.checks.crossfadeMs, 120);
    assert.deepEqual(readFileSync(h.app.store.takeAudioPath(r.take.id)!), before);
    assert.equal(h.app.store.listJobsByStatus(["done"]).length, jobs);
    const file = decodeWav(readFileSync(h.app.store.takeAudioPath(refined.id)!));
    const old = decodeWav(before);
    assert.equal(compareOutside(file, old, 3 * file.sampleRate, 6 * file.sampleRate).mismatches, 0);
  } finally {
    await h.stop();
  }
});
