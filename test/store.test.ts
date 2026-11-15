// The project is a folder of plain files: layout, hand edits, lyrics.md, migration.

import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { copyFile, mkdtemp, readdir, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { migrateFromSqlite } from "../server/migrate.ts";
import { ProjectStore, slugify } from "../server/store.ts";
import { FIXTURES } from "./helpers.ts";
import { SONG, startHarness } from "./harness.ts";

const readJson = (f: string) => JSON.parse(readFileSync(f, "utf8"));
const lines = (f: string) => readFileSync(f, "utf8").trim().split("\n").map((l) => JSON.parse(l));

test("store: a project is a folder with song.json, lyrics.md, takes/, history and chat logs", async () => {
  const h = await startHarness();
  try {
    const project = h.app.studio.createProject("Paper Boats");
    assert.match(project.id, /^paper-boats-[0-9a-f]{4}$/);
    assert.equal(project.path, path.join(h.app.store.root, project.id));
    const gen = await h.app.studio.startGenerate(project.id, SONG);
    await h.settle();
    await h.app.studio.startRepaint(project.id, { takeId: gen.take.id, startSec: 3, endSec: 7, lyrics: SONG.lyrics.replace("Paper", "Silver") });
    await h.settle();

    const dir = project.path;
    assert.deepEqual((await readdir(dir)).sort(), [".gitignore", ".studio", "chat.jsonl", "history.jsonl", "lyrics.md", "song.json", "takes"]);
    assert.deepEqual(
      (await readdir(path.join(dir, "takes"))).sort(),
      ["take-001.json", "take-001.peaks.json", "take-001.timing.json", "take-001.wav", "take-002.json", "take-002.peaks.json", "take-002.timing.json", "take-002.wav"],
    );
    assert.equal(readFileSync(path.join(dir, ".gitignore"), "utf8").includes(".studio/"), true);

    const song = readJson(path.join(dir, "song.json"));
    assert.equal(song.format, "song-studio/1");
    assert.equal(song.title, "Paper Boats");
    const takes = h.takes(project.id);
    assert.equal(song.currentTake, takes[1].id);
    assert.equal(song.current.audio, "takes/take-002.wav");
    assert.equal(song.current.bpm, 96);

    const take2 = readJson(path.join(dir, "takes", "take-002.json"));
    assert.equal(take2.id, takes[1].id);
    assert.equal(take2.parentTakeId, takes[0].id);
    assert.equal(take2.audio, "take-002.wav");
    assert.equal(take2.checks.bitIdenticalOutside, true);
    assert.equal(take2.projectId, undefined, "the project is the folder, not a field");

    assert.equal(readFileSync(path.join(dir, "lyrics.md"), "utf8"), SONG.lyrics.replace("Paper", "Silver") + "\n");

    const events = lines(path.join(dir, "history.jsonl")).map((e) => e.event);
    assert.deepEqual(events, ["project_created", "take_queued", "take_ready", "timing_found", "take_queued", "take_ready", "timing_found"]);
    assert.ok(lines(path.join(dir, "history.jsonl")).every((e) => !Number.isNaN(Date.parse(e.at))));

    // A job file per job, out of git's way.
    assert.equal((await readdir(path.join(dir, ".studio", "jobs"))).length, 2);
  } finally {
    await h.stop();
  }
});

test("store: chat is an append-only JSON-lines file, replayed exactly", async () => {
  const h = await startHarness();
  try {
    const p = h.app.studio.createProject();
    await h.say(p.id, "hello");
    const file = path.join(p.path, "chat.jsonl");
    const raw = lines(file);
    assert.equal(raw[0].role, "user");
    assert.equal(raw[0].text, "hello");
    assert.match(raw[0].llm.text, /<studio_state>/, "the exact text the model saw is kept with the message");
    assert.deepEqual(raw.map((l) => l.id), raw.map((_, i) => i + 1));
    assert.deepEqual(h.app.store.listMessages(p.id).map((m) => m.id), raw.map((l) => l.id));
  } finally {
    await h.stop();
  }
});

test("store: edits made outside the app are read back (title, sections)", async () => {
  const h = await startHarness();
  try {
    const p = h.app.studio.createProject("Before");
    const gen = await h.app.studio.startGenerate(p.id, SONG);
    await h.settle();
    const file = path.join(p.path, "song.json");
    const song = readJson(file);
    song.title = "Renamed in an editor";
    song.sections = { [gen.take.id]: [{ label: "hook", startSec: 1, endSec: 4 }] };
    writeFileSync(file, JSON.stringify(song, null, 2));
    assert.equal(h.app.studio.project(p.id).title, "Renamed in an editor");
    assert.deepEqual(h.app.studio.markers(p.id), [{ label: "hook", startSec: 1, endSec: 4 }]);

    // A broken file does not take the app down.
    writeFileSync(file, "{ not json");
    assert.throws(() => h.app.studio.project(p.id), /does not exist/);
    assert.ok(Array.isArray(h.app.studio.listProjects()));
  } finally {
    await h.stop();
  }
});

test("store: lyrics.md follows the current take, but hand edits are kept and reported as a draft", async () => {
  const h = await startHarness();
  try {
    const p = h.app.studio.createProject();
    const t1 = (await h.app.studio.startGenerate(p.id, SONG)).take;
    await h.settle();
    const lyricsFile = path.join(p.path, "lyrics.md");
    assert.equal(h.app.store.lyricsDraft(p.id), null, "freshly written: no draft");

    const edited = SONG.lyrics.replace("Paper boats along the gutter stream", "Tin cans down the alley");
    writeFileSync(lyricsFile, edited + "\n");
    assert.equal(h.app.store.lyricsDraft(p.id), edited);
    assert.equal(h.app.studio.snapshot(p.id).lyricsDraft, edited);

    // A repaint with other lyrics finishes: the hand edits are NOT overwritten.
    const other = SONG.lyrics.replace("Hold on, hold on", "Row on, row on");
    const t2 = (await h.app.studio.startRepaint(p.id, { takeId: t1.id, startSec: 2, endSec: 4, lyrics: other })).take;
    await h.settle();
    assert.equal(readFileSync(lyricsFile, "utf8"), edited + "\n");
    assert.ok(h.app.store.history(p.id).some((e) => e.event === "lyrics_kept"));

    // Singing the edited lyrics makes lyrics.md clean again.
    await h.app.studio.startRepaint(p.id, { takeId: t2.id, startSec: 2, endSec: 4, lyrics: edited });
    await h.settle();
    assert.equal(h.app.store.lyricsDraft(p.id), null);

    // Reverting while clean rewrites lyrics.md to the reverted take's lyrics.
    h.app.studio.setCurrentTake(p.id, t1.id);
    assert.equal(readFileSync(lyricsFile, "utf8"), SONG.lyrics + "\n");
  } finally {
    await h.stop();
  }
});

test("store: project ids are folder names and cannot escape the projects folder", () => {
  const store = new ProjectStore(path.join(os.tmpdir(), `song-studio-ids-${process.pid}`));
  try {
    assert.equal(slugify("Ça va? Paper / Boats!"), "ca-va-paper-boats");
    assert.equal(slugify("!!!"), "song");
    assert.equal(store.getProject("../etc"), null);
    assert.throws(() => store.projectDir("../etc"), /invalid project id/);
    assert.equal(store.getProject("UPPER"), null);
  } finally {
    rmSyncQuiet(store.root);
  }
});

function rmSyncQuiet(dir: string) {
  void rm(dir, { recursive: true, force: true });
}

test("store: an old studio.db is moved into folders once, keeping ids, audio, markers and chat", async () => {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), "song-studio-migrate-"));
  try {
    mkdirSync(path.join(dataDir, "audio"));
    await copyFile(path.join(FIXTURES, "folk_orig_16s.wav"), path.join(dataDir, "audio", "t_aaaaaa.wav"));
    writeFileSync(path.join(dataDir, "audio", "t_aaaaaa.peaks.json"), "[0.5]");
    const db = new DatabaseSync(path.join(dataDir, "studio.db"));
    db.exec(`
      CREATE TABLE projects (id TEXT PRIMARY KEY, title TEXT, current_take_id TEXT, selection_json TEXT, created_at INTEGER, updated_at INTEGER);
      CREATE TABLE takes (id TEXT PRIMARY KEY, project_id TEXT, seq INTEGER, parent_take_id TEXT, root_take_id TEXT, kind TEXT, status TEXT,
        params_json TEXT, change_summary TEXT, audio_file TEXT, duration_sec REAL, sample_rate INTEGER, checks_json TEXT, error TEXT, job_id TEXT,
        created_at INTEGER, finished_at INTEGER);
      CREATE TABLE markers (project_id TEXT, root_take_id TEXT, position INTEGER, label TEXT, start_sec REAL, end_sec REAL);
      CREATE TABLE messages (id INTEGER PRIMARY KEY, project_id TEXT, role TEXT, content_json TEXT, llm_json TEXT, created_at INTEGER);
    `);
    const params = { ...SONG, timeSignature: "4", vocalLanguage: "en", seed: 1, repaint: null };
    db.prepare("INSERT INTO projects VALUES ('p_12345678', 'Old Song', 't_aaaaaa', NULL, 1000, 2000)").run();
    db.prepare("INSERT INTO takes VALUES ('t_aaaaaa', 'p_12345678', 1, NULL, 't_aaaaaa', 'generate', 'done', ?, 'New song', 't_aaaaaa.wav', 16, 48000, NULL, NULL, 'j_1', 1000, 1500)").run(JSON.stringify(params));
    db.prepare("INSERT INTO takes VALUES ('t_bbbbbb', 'p_12345678', 2, 't_aaaaaa', 't_aaaaaa', 'repaint', 'running', ?, 'half done', NULL, NULL, NULL, NULL, NULL, 'j_2', 1600, NULL)").run(JSON.stringify(params));
    db.prepare("INSERT INTO markers VALUES ('p_12345678', 't_aaaaaa', 0, 'chorus', 3, 6)").run();
    db.prepare("INSERT INTO messages VALUES (7, 'p_12345678', 'user', ?, ?, 1100)").run(JSON.stringify({ role: "user", text: "hi", selection: null }), JSON.stringify({ text: "hi + state" }));
    db.close();

    const store = new ProjectStore(path.join(dataDir, "projects"));
    assert.deepEqual(migrateFromSqlite(dataDir, store), { projects: 1, takes: 2 });
    assert.equal(existsSync(path.join(dataDir, "studio.db")), false);
    assert.equal(existsSync(path.join(dataDir, "studio.db.migrated")), true, "the old database is kept, renamed");
    assert.equal(existsSync(path.join(dataDir, "audio", "t_aaaaaa.wav")), true, "old audio is copied, not moved");
    assert.equal(migrateFromSqlite(dataDir, store), null, "runs once");

    const [p] = store.listProjects();
    assert.equal(p.id, "old-song-1234");
    assert.equal(p.title, "Old Song");
    assert.equal(p.currentTakeId, "t_aaaaaa");
    const takes = store.listTakes(p.id);
    assert.deepEqual(takes.map((t) => [t.id, t.seq, t.status]), [["t_aaaaaa", 1, "done"], ["t_bbbbbb", 2, "failed"]]);
    assert.match(takes[1].error!, /unfinished/);
    assert.equal(readFileSync(store.takeAudioPath("t_aaaaaa")!).equals(readFileSync(path.join(FIXTURES, "folk_orig_16s.wav"))), true);
    assert.deepEqual(store.getMarkers(p.id, "t_aaaaaa"), [{ label: "chorus", startSec: 3, endSec: 6 }]);
    const [m] = store.listStoredMessages(p.id);
    assert.equal(m.message.id, 7);
    assert.deepEqual(m.llm, { text: "hi + state" });
    assert.equal(readFileSync(store.lyricsFile(p.id), "utf8"), SONG.lyrics + "\n");
  } finally {
    await rm(dataDir, { recursive: true, force: true });
  }
});
