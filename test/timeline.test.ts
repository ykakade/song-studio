// The timeline: library sounds, the beat grid, clips layered on a song, the mix,
// and the same operations through HTTP, the chat agent and MCP.

import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { estimateBeatGrid, snapToBeat } from "../server/beats.ts";
import { renderMix } from "../server/mix.ts";
import { parseKey, renderSound, SOUND_LIBRARY, soundFileName } from "../server/sounds.ts";
import { StudioError } from "../server/studio.ts";
import type { Clip, Timeline, Track } from "../server/types.ts";
import { decodeWav, encodeWav, type WavAudio } from "../server/wav.ts";
import { synth } from "./helpers.ts";
import { SONG, startHarness, type Harness } from "./harness.ts";

const RENDER = { bpm: 100, key: "A Minor", beatsPerBar: 4, sampleRate: 48000 };

function repeated(loop: WavAudio, times: number, leadSec = 0): WavAudio {
  const lead = Math.round(leadSec * loop.sampleRate) * loop.channels;
  const samples = new Int16Array(lead + loop.samples.length * times);
  for (let i = 0; i < times; i++) samples.set(loop.samples, lead + i * loop.samples.length);
  return { ...loop, samples };
}

async function songProject(h: Harness) {
  const project = h.app.studio.createProject();
  const { take } = await h.app.studio.startGenerate(project.id, { ...SONG, seed: 1 });
  await h.settle();
  return { project, take: h.app.store.getTake(take.id)! };
}

test("sounds: every library sound renders, at -6 dBFS, and loops are exactly two bars", () => {
  assert.ok(SOUND_LIBRARY.length >= 10);
  for (const s of SOUND_LIBRARY) {
    const a = renderSound(s.id, RENDER);
    assert.equal(a.sampleRate, 48000);
    assert.equal(a.channels, 2);
    let peak = 0;
    for (const v of a.samples) peak = Math.max(peak, Math.abs(v));
    assert.ok(peak >= 16380 && peak <= 16384, `${s.id} peaks at ${peak}`);
    if (s.loop) assert.equal(a.samples.length / 2, Math.round((60 / 100) * 4 * 2 * 48000), `${s.id} is two bars long`);
    assert.deepEqual(renderSound(s.id, RENDER).samples, a.samples, `${s.id} renders the same bytes every time`);
  }
  assert.throws(() => renderSound("drums.nope", RENDER));
});

test("sounds: the key and tempo are part of a rendered file's name", () => {
  const drums = SOUND_LIBRARY.find((s) => s.id === "drums.backbeat")!;
  const guitar = SOUND_LIBRARY.find((s) => s.id === "guitar.strum")!;
  assert.equal(soundFileName(drums, RENDER), "drums-backbeat-100bpm-4-4.wav");
  assert.equal(soundFileName(drums, { ...RENDER, bpm: 94.96 }), "drums-backbeat-94.96bpm-4-4.wav");
  assert.equal(soundFileName(guitar, RENDER), "guitar-strum-100bpm-4-4-a-minor.wav");
  assert.deepEqual(parseKey("F# minor"), { pitchClass: 6, minor: true });
  assert.deepEqual(parseKey("Bb Major"), { pitchClass: 10, minor: false });
  assert.deepEqual(parseKey("Am"), { pitchClass: 9, minor: true });
  assert.deepEqual(parseKey("nonsense?"), { pitchClass: 0, minor: false });
  assert.notDeepEqual(renderSound("guitar.strum", RENDER).samples, renderSound("guitar.strum", { ...RENDER, key: "C Major" }).samples);
});

test("beats: finds the real tempo and the first downbeat of a drum loop", () => {
  // Played at 97.3 bpm, starting 0.41 s in, while 100 bpm was "asked for".
  const loop = renderSound("drums.backbeat", { ...RENDER, bpm: 97.3 });
  const grid = estimateBeatGrid(repeated(loop, 6, 0.41), 100);
  assert.equal(grid.detected, true);
  assert.ok(Math.abs(grid.bpm - 97.3) < 0.06, `bpm ${grid.bpm}`);
  assert.ok(Math.abs(grid.firstBeatSec - 0.41) < 0.02, `first beat ${grid.firstBeatSec}`);
  assert.ok(Math.abs(snapToBeat(grid, 5) - (0.41 + 7 * (60 / 97.3))) < 0.03);
  assert.equal(snapToBeat(grid, -3), 0, "never before the start");
});

test("beats: audio without a beat falls back to the tempo that was asked for", () => {
  const frames = 48000 * 8;
  const samples = new Int16Array(frames * 2);
  for (let i = 0; i < frames; i++) samples[i * 2] = samples[i * 2 + 1] = Math.round(8000 * Math.sin((2 * Math.PI * 220 * i) / 48000));
  assert.deepEqual(estimateBeatGrid({ sampleRate: 48000, channels: 2, samples }, 120), { bpm: 120, beatSec: 0.5, firstBeatSec: 0, beatsPerBar: 4, detected: false });
});

test("mix: adds clips to the song sample for sample, loops them, honours mute and gain, never clips", () => {
  const sr = 8000;
  const song = synth(4, 3, { sampleRate: sr, level: 0.2 });
  const tone: WavAudio = { sampleRate: sr, channels: 1, samples: Int16Array.from({ length: sr / 2 }, () => 1000) };
  const tracks: Track[] = [
    { id: "a", name: "A", muted: false, gainDb: 0 },
    { id: "b", name: "B", muted: true, gainDb: 0 },
  ];
  const clip = (over: Partial<Clip>): Clip => ({ id: "c", trackId: "a", sound: "import", name: "tone", instrument: "audio", file: "tone.wav", fileDurationSec: 0.5, loop: false, startSec: 1, durationSec: 0.5, gainDb: 0, ...over });
  const load = (f: string) => (f === "tone.wav" ? tone : null);
  const at = (a: WavAudio, sec: number) => a.samples[Math.round(sec * sr) * a.channels];
  const base = (sec: number) => at(song, sec);

  const once = renderMix(song, tracks, [clip({})], load);
  assert.equal(once.scaledBy, 1);
  assert.equal(at(once.audio, 1.25), base(1.25) + 1000, "inside the clip: song plus sound");
  assert.equal(at(once.audio, 0.9), base(0.9), "before the clip: the song alone");
  assert.equal(at(once.audio, 1.6), base(1.6), "a one-shot does not repeat");
  assert.equal(once.audio.samples.length, song.samples.length);

  const looped = renderMix(song, tracks, [clip({ loop: true, durationSec: 2 })], load);
  assert.equal(at(looped.audio, 2.7), base(2.7) + 1000, "a loop repeats to fill its clip");
  assert.equal(at(looped.audio, 3.2), base(3.2));

  assert.equal(at(renderMix(song, tracks, [clip({ trackId: "b" })], load).audio, 1.25), base(1.25), "a muted track is silent");
  assert.equal(at(renderMix(song, tracks, [clip({ gainDb: -6.0206 })], load).audio, 1.25), base(1.25) + 500);
  assert.deepEqual(renderMix(song, tracks, [clip({ file: "gone.wav" })], load).missing, ["gone.wav"]);

  const loud = renderMix(song, tracks, [clip({ gainDb: 36 })], load);
  assert.ok(loud.scaledBy < 1);
  assert.ok(loud.audio.samples.every((v) => v >= -32767 && v <= 32767));
});

test("timeline: adding a sound writes its file and a clip; moving, resizing and removing it", async () => {
  const h = await startHarness();
  try {
    const empty = h.app.studio.createProject();
    assert.equal(h.app.studio.timeline(empty.id), null);
    assert.throws(() => h.app.studio.addSound(empty.id, { sound: "drums.backbeat" }), (e: any) => e instanceof StudioError && /no finished take/.test(e.message));

    const { project, take } = await songProject(h);
    const before = readFileSync(h.app.store.takeAudioPath(take.id)!);
    const start = h.app.studio.timeline(project.id)!;
    assert.deepEqual([start.tracks, start.clips, start.durationSec], [[], [], 12]);
    assert.ok(existsSync(h.app.store.takePath(take, ".beats.json")), "the beat grid is kept next to the take");

    const events: string[] = [];
    h.app.bus.subscribe(project.id, (e) => events.push(e.type));
    const { clip, timeline } = h.app.studio.addSound(project.id, { sound: "drums.backbeat" });
    assert.equal(clip.loop, true);
    assert.equal(clip.startSec, timeline.grid.firstBeatSec < 11 ? timeline.grid.firstBeatSec : 0);
    assert.ok(Math.abs(clip.startSec + clip.durationSec - 12) < 0.002, "a loop runs to the end of the song by default");
    assert.deepEqual(timeline.tracks.map((t) => t.name), ["Drums"]);
    assert.ok(events.includes("state"), "open browsers are told");
    const file = path.join(project.path, "sounds", clip.file);
    assert.ok(existsSync(file));
    assert.ok(Math.abs(clip.fileDurationSec - 2 * 4 * timeline.grid.beatSec) < 0.01, "rendered at the song's measured tempo");
    const saved = JSON.parse(readFileSync(path.join(project.path, "timeline.json"), "utf8"));
    assert.equal(saved.songs[take.id].clips[0].id, clip.id);

    // A second drum part overlapping the first gets its own track; a non-overlapping one shares.
    const second = h.app.studio.addSound(project.id, { sound: "drums.half-time", startSec: 2, endSec: 6 });
    assert.deepEqual(second.timeline.tracks.map((t) => t.name), ["Drums", "Drums 2"]);
    const crash = h.app.studio.addSound(project.id, { sound: "percussion.crash", startSec: 4 });
    assert.equal(crash.clip.loop, false);
    assert.ok(Math.abs(crash.clip.durationSec - 3) < 0.01, "a one-shot is as long as its sound");
    const guitar = h.app.studio.addSound(project.id, { sound: "guitar.strum", startSec: 1, endSec: 5, gainDb: -6 });
    assert.match(guitar.clip.file, /g-major\.wav$/);
    assert.equal(guitar.clip.gainDb, -6);

    const moved = h.app.studio.updateClip(project.id, second.clip.id, { startSec: 7 });
    assert.equal(moved.clip.startSec, 7);
    assert.equal(moved.clip.durationSec, 4, "a move keeps the length");
    assert.equal(h.app.studio.updateClip(project.id, second.clip.id, { startSec: 11 }).clip.startSec, 8, "and stops at the end of the song");
    const resized = h.app.studio.updateClip(project.id, second.clip.id, { durationSec: 30 });
    assert.equal(resized.clip.durationSec, 4, "a resize is cut at the end of the song");
    assert.ok(h.app.studio.updateClip(project.id, crash.clip.id, { durationSec: 9 }).clip.durationSec <= 3.001, "a one-shot cannot be longer than its sound");
    assert.equal(h.app.studio.updateClip(project.id, guitar.clip.id, { gainDb: 99 }).clip.gainDb, 12, "volume is kept in range");

    // Moving the only clip off a track removes the track.
    const merged = h.app.studio.updateClip(project.id, second.clip.id, { trackId: guitar.clip.trackId });
    assert.ok(!merged.timeline.tracks.some((t) => t.name === "Drums 2"));
    const own = h.app.studio.updateClip(project.id, second.clip.id, { newTrack: true });
    assert.equal(own.timeline.tracks.at(-1)!.id, own.clip.trackId);

    const muted = h.app.studio.updateTrack(project.id, timeline.tracks[0].id, { muted: true, gainDb: -3, name: "Kit" });
    assert.deepEqual(muted.tracks[0], { id: timeline.tracks[0].id, name: "Kit", muted: true, gainDb: -3 });

    const after = h.app.studio.removeClip(project.id, clip.id);
    assert.ok(!after.clips.some((c) => c.id === clip.id));
    assert.ok(!after.tracks.some((t) => t.name === "Kit"), "an empty track goes away");
    assert.ok(existsSync(file), "the sound file stays in sounds/");
    assert.throws(() => h.app.studio.removeClip(project.id, clip.id), (e: any) => e.code === "not_found");
    assert.throws(() => h.app.studio.addSound(project.id, { sound: "kazoo" }), /no sound "kazoo"/);
    assert.throws(() => h.app.studio.addSound(project.id, { sound: "drums.backbeat", startSec: 40 }), /outside the song/);

    assert.deepEqual(readFileSync(h.app.store.takeAudioPath(take.id)!), before, "the take's audio is never touched");
    const logged = h.app.store.history(project.id).map((e) => e.event);
    for (const ev of ["sound_added", "sound_changed", "sound_removed", "track_changed"]) assert.ok(logged.includes(ev), ev);
  } finally {
    await h.stop();
  }
});

test("timeline: clips belong to the song, so a repaint keeps them and a new song starts empty", async () => {
  const h = await startHarness();
  try {
    const { project, take } = await songProject(h);
    const { clip } = h.app.studio.addSound(project.id, { sound: "percussion.shaker" });
    const grid = h.app.studio.timeline(project.id)!.grid;
    await h.app.studio.startRepaint(project.id, { takeId: take.id, startSec: 4, endSec: 8, lyrics: SONG.lyrics });
    await h.settle();
    const afterRepaint = h.app.studio.timeline(project.id)!;
    assert.deepEqual(afterRepaint.clips.map((c) => c.id), [clip.id]);
    assert.deepEqual(afterRepaint.grid, grid, "one beat grid for the whole song");

    await h.app.studio.startGenerate(project.id, { ...SONG, title: "Another", seed: 5 });
    await h.settle();
    assert.deepEqual(h.app.studio.timeline(project.id)!.clips, []);
    h.app.studio.setCurrentTake(project.id, take.id);
    assert.equal(h.app.studio.timeline(project.id)!.clips.length, 1, "going back brings the song's sounds back");

    // A hand edit that breaks an entry loses that entry, not the timeline.
    const file = path.join(project.path, "timeline.json");
    const data = JSON.parse(readFileSync(file, "utf8"));
    data.songs[take.id].clips.push({ id: "c_bad", trackId: "nope", file: "../../etc/passwd", startSec: "x" });
    writeFileSync(file, JSON.stringify(data));
    assert.equal(h.app.studio.timeline(project.id)!.clips.length, 1);
  } finally {
    await h.stop();
  }
});

test("timeline over HTTP: library, clips, import, sound files, state and the mix", async () => {
  const h = await startHarness();
  try {
    const { project, take } = await songProject(h);
    const api = async (method: string, url: string, body?: unknown) => {
      const res = await fetch(`${h.url}${url}`, { method, headers: body ? { "content-type": "application/json" } : undefined, body: body ? JSON.stringify(body) : undefined });
      return { status: res.status, data: (await res.json()) as any };
    };
    const lib = await api("GET", "/api/sounds");
    assert.ok(lib.data.sounds.some((s: any) => s.id === "drums.backbeat" && s.instrument === "drums"));
    const preview = await fetch(`${h.url}/api/sounds/keys.piano/audio?bpm=90&key=D%20Minor`);
    assert.equal(preview.headers.get("content-type"), "audio/wav");
    assert.equal(decodeWav(Buffer.from(await preview.arrayBuffer())).sampleRate, 48000);
    assert.equal((await fetch(`${h.url}/api/sounds/nope/audio`)).status, 404);

    const added = await api("POST", `/api/projects/${project.id}/clips`, { sound: "drums.backbeat", startSec: 2.013, endSec: 6.5 });
    assert.equal(added.status, 201);
    assert.equal(added.data.clip.startSec, 2.013, "the web client snaps for itself; the API keeps what it is given");
    const clipId = added.data.clip.id;
    assert.equal((await api("POST", `/api/projects/${project.id}/clips`, { sound: "kazoo" })).status, 400);

    const state = await api("GET", `/api/projects/${project.id}`);
    assert.equal(state.data.timeline.clips[0].id, clipId);
    assert.equal(state.data.timeline.durationSec, 12);

    const patched = await api("PATCH", `/api/projects/${project.id}/clips/${clipId}`, { startSec: 3, gainDb: -4 });
    assert.deepEqual([patched.data.clip.startSec, patched.data.clip.gainDb], [3, -4]);
    assert.equal((await api("PATCH", `/api/projects/${project.id}/clips/c_nope`, { startSec: 3 })).status, 404);
    const track = await api("PATCH", `/api/projects/${project.id}/tracks/${patched.data.clip.trackId}`, { muted: true });
    assert.equal(track.data.timeline.tracks[0].muted, true);

    // The clip's audio is served from sounds/, and nothing else is.
    const audio = await fetch(`${h.url}/api/projects/${project.id}/sounds/${added.data.clip.file}`);
    assert.equal(audio.status, 200);
    assert.deepEqual(Buffer.from(await audio.arrayBuffer()), readFileSync(path.join(project.path, "sounds", added.data.clip.file)));
    assert.equal((await fetch(`${h.url}/api/projects/${project.id}/sounds/..%2Fsong.json`)).status, 404);
    assert.equal((await fetch(`${h.url}/api/projects/${project.id}/sounds/nope.wav`)).status, 404);

    // Import a file of our own.
    const mine = encodeWav(synth(1.5, 9, { sampleRate: 22050, channels: 1 }));
    const imported = await fetch(`${h.url}/api/projects/${project.id}/clips/import?name=${encodeURIComponent("My Riff.wav")}&startSec=5`, { method: "POST", body: new Uint8Array(mine) });
    assert.equal(imported.status, 201);
    const imp = ((await imported.json()) as any).clip;
    assert.deepEqual([imp.name, imp.sound, imp.instrument, imp.loop, imp.startSec, imp.durationSec], ["My Riff", "import", "audio", false, 5, 1.5]);
    assert.match(imp.file, /^my-riff-[0-9a-f]+\.wav$/);
    const bad = await fetch(`${h.url}/api/projects/${project.id}/clips/import?name=x`, { method: "POST", body: new Uint8Array([1, 2, 3]) });
    assert.equal(bad.status, 400);

    // The mix: same length as the take, different inside the imported clip, identical where nothing plays (the drums are muted).
    const mixRes = await fetch(`${h.url}/api/projects/${project.id}/takes/${take.id}/mix?download`);
    assert.match(mixRes.headers.get("content-disposition")!, /Paper Boats - take 1 mix\.wav/);
    const mix = decodeWav(Buffer.from(await mixRes.arrayBuffer()));
    const song = decodeWav(readFileSync(h.app.store.takeAudioPath(take.id)!));
    assert.equal(mix.samples.length, song.samples.length);
    // When the sum would go over full scale the whole mix is turned down; allow for that factor.
    const { scaledBy } = h.app.studio.mix(project.id, take.id);
    const differs = (from: number, to: number) => {
      for (let i = Math.round(from * 48000) * 2; i < Math.round(to * 48000) * 2; i++) if (Math.abs(mix.samples[i] - song.samples[i] * scaledBy) > 1) return true;
      return false;
    };
    assert.equal(differs(0, 4.9), false);
    assert.equal(differs(5.1, 6.4), true);
    assert.equal(differs(6.6, 12), false);

    const removed = await api("DELETE", `/api/projects/${project.id}/clips/${clipId}`);
    assert.equal(removed.data.timeline.clips.length, 1);
  } finally {
    await h.stop();
  }
});

test("timeline by chat: \"add drums\" puts a clip on the timeline at once; \"remove the drums\" takes it off", async () => {
  const h = await startHarness();
  try {
    const { project } = await songProject(h);
    const takesBefore = h.takes(project.id).length;
    let messages = await h.say(project.id, "add a drum sound");
    const timeline = h.app.studio.timeline(project.id)!;
    assert.equal(timeline.clips.length, 1);
    assert.equal(timeline.clips[0].sound, "drums.backbeat");
    assert.equal(h.takes(project.id).length, takesBefore, "no take is made and no job runs");
    const tool = messages.findLast((m) => m.role === "tool")!;
    assert.equal(tool.role === "tool" && tool.results[0].name, "add_sound");
    assert.equal(tool.role === "tool" && tool.results[0].isError, false);

    // The next message tells the model what is on the timeline.
    messages = await h.say(project.id, "put a shaker on the part I selected", { startSec: 4, endSec: 8 });
    const shaker = h.app.studio.timeline(project.id)!.clips.find((c) => c.sound === "percussion.shaker")!;
    const grid = h.app.studio.timeline(project.id)!.grid;
    assert.ok(Math.abs(shaker.startSec - 4) <= grid.beatSec / 2 + 0.001 && Math.abs(shaker.startSec + shaker.durationSec - 8) <= grid.beatSec / 2 + 0.001, "the selection, moved onto beats");
    const seen = h.app.store.listStoredMessages(project.id).filter((s) => s.message.role === "user").at(-1)!.llm as { text: string };
    assert.match(seen.text, new RegExp(`sounds on the timeline: ${timeline.clips[0].id} drums\\.backbeat [\\d.]+–12\\.00 s on track tr_[0-9a-f]+ "Drums"`));

    await h.say(project.id, "remove the drums");
    assert.deepEqual(h.app.studio.timeline(project.id)!.clips.map((c) => c.sound), ["percussion.shaker"]);

    const state = (await (await fetch(`${h.url}/api/projects/${project.id}/agent-state`)).json()) as any;
    assert.equal(state.timeline.tracks[0].clips[0].sound, "percussion.shaker");
    assert.ok(state.timeline.beat.bpm > 0);
  } finally {
    await h.stop();
  }
});

test("timeline by MCP: an outside agent adds, changes and mutes sounds", async () => {
  const h = await startHarness();
  try {
    const { project } = await songProject(h);
    const call = async (name: string, args: Record<string, unknown>) => {
      const res = await fetch(`${h.url}/mcp`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: { project_id: project.id, ...args } } }),
      });
      const r = ((await res.json()) as any).result;
      return { isError: r.isError as boolean, data: r.structuredContent, text: r.content[0].text as string };
    };
    const added = await call("add_sound", { sound: "bass.pulse", volume_db: -6 });
    assert.equal(added.isError, false);
    assert.match(added.data.note, /home chord/);
    const id = added.data.clip.clip_id;
    assert.equal((await call("update_sound", { clip_id: id, volume_db: -12 })).data.clip.volume_db, -12);
    assert.equal((await call("set_track", { track_id: added.data.clip.track_id, muted: true })).data.track.muted, true);
    assert.equal((await call("set_track", { track_id: added.data.clip.track_id, muted: "yes" })).isError, true);
    assert.equal((await call("add_sound", { sound: "kazoo" })).isError, true);
    const state = await call("get_project_state", {});
    assert.equal(state.data.timeline.tracks[0].clips[0].clip_id, id);
    assert.equal((await call("remove_sound", { clip_id: id })).data.removed, true);
    assert.equal(h.app.studio.timeline(project.id)!.clips.length, 0);
  } finally {
    await h.stop();
  }
});

export type { Timeline };
