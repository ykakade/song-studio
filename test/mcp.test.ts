// The studio as an MCP server (Streamable HTTP at /mcp), driven like an outside agent would.

import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { SONG, startHarness } from "./harness.ts";

async function rpc(url: string, method: string, params?: unknown, headers: Record<string, string> = {}, id: number | null = 1) {
  const res = await fetch(`${url}/mcp`, {
    method: "POST",
    headers: { "content-type": "application/json", accept: "application/json, text/event-stream", ...headers },
    body: JSON.stringify({ jsonrpc: "2.0", method, ...(id === null ? {} : { id }), ...(params === undefined ? {} : { params }) }),
  });
  const text = await res.text();
  return { status: res.status, type: res.headers.get("content-type"), body: text ? JSON.parse(text) : null };
}

async function call(url: string, name: string, args: unknown) {
  const r = await rpc(url, "tools/call", { name, arguments: args });
  assert.equal(r.status, 200);
  const result = r.body.result;
  return { isError: result.isError as boolean, text: result.content[0].text as string, data: result.structuredContent };
}

test("mcp: handshake, tool list, and the protocol edges", async () => {
  const h = await startHarness();
  try {
    const init = await rpc(h.url, "initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "test", version: "1" } });
    assert.equal(init.status, 200);
    assert.match(init.type!, /application\/json/);
    assert.equal(init.body.result.protocolVersion, "2025-06-18");
    assert.equal(init.body.result.serverInfo.name, "song-studio");
    assert.ok(init.body.result.capabilities.tools);
    assert.match(init.body.result.instructions, /Never estimate a time range/);
    assert.equal((await rpc(h.url, "initialize", { protocolVersion: "1999-01-01" })).body.result.protocolVersion, "2025-06-18", "unknown versions get ours");

    assert.equal((await rpc(h.url, "notifications/initialized", undefined, {}, null)).status, 202);
    assert.deepEqual((await rpc(h.url, "ping")).body.result, {});

    const list = await rpc(h.url, "tools/list");
    const names = list.body.result.tools.map((t: any) => t.name);
    assert.deepEqual(names, ["list_projects", "create_project", "generate_song", "repaint_section", "get_project_state", "set_section_markers", "revert_to_take", "wait_for_job"]);
    const repaint = list.body.result.tools.find((t: any) => t.name === "repaint_section");
    assert.equal(repaint.inputSchema.required[0], "project_id");
    assert.ok(!JSON.stringify(list.body.result.tools).includes("<studio_state>"), "no references to the built-in chat's context block");

    assert.equal((await rpc(h.url, "nope/method")).body.error.code, -32601);
    assert.equal((await rpc(h.url, "tools/call", { name: "nope" })).body.error.code, -32602);
    assert.equal((await rpc(h.url, "ping", undefined, { origin: "https://evil.example" })).status, 403, "web pages from elsewhere are refused");
    assert.equal((await rpc(h.url, "ping", undefined, { origin: "http://localhost:5173" })).status, 200);
    assert.equal((await fetch(`${h.url}/mcp`)).status, 405, "no server-initiated stream");
  } finally {
    await h.stop();
  }
});

test("mcp: an outside agent makes a song, waits for it, then repaints a heard section", async () => {
  const h = await startHarness();
  try {
    const created = await call(h.url, "create_project", { title: "From Outside" });
    assert.equal(created.isError, false);
    const pid = created.data.id;
    assert.ok(existsSync(created.data.folder));

    const gen = await call(h.url, "generate_song", {
      project_id: pid,
      title: SONG.title,
      style_prompt: SONG.stylePrompt,
      lyrics: SONG.lyrics,
      bpm: SONG.bpm,
      key: SONG.key,
      duration_seconds: SONG.durationSec,
    });
    assert.equal(gen.isError, false, gen.text);
    const done = await call(h.url, "wait_for_job", { job_id: gen.data.job_id, timeout_seconds: 30 });
    assert.equal(done.data.status, "done");
    assert.equal(done.data.take.lyric_words_heard, "12/12", "the answer waits for the take to be analysed");
    assert.ok(existsSync(done.data.take.audio_file));

    const state = await call(h.url, "get_project_state", { project_id: pid });
    const chorus = state.data.current_take.heard_in_audio.sections.find((s: any) => s.label === "chorus");
    assert.equal(state.data.project_folder, created.data.folder);

    // A guessed range is refused, exactly as for the built-in assistant.
    const guessed = await call(h.url, "repaint_section", {
      project_id: pid, take_id: done.data.take.id, start_seconds: 4, end_seconds: 8, range_source: "selection", lyrics: SONG.lyrics, change_summary: "x",
    });
    assert.equal(guessed.isError, true);
    assert.match(guessed.text, /no selection on the waveform/);

    const rep = await call(h.url, "repaint_section", {
      project_id: pid, take_id: done.data.take.id, start_seconds: chorus.start_seconds, end_seconds: chorus.end_seconds,
      range_source: "detected_section", section_label: "chorus", lyrics: SONG.lyrics, change_summary: "bigger chorus",
    });
    assert.equal(rep.isError, false, rep.text);
    const repDone = await call(h.url, "wait_for_job", { job_id: rep.data.job_id });
    assert.equal(repDone.data.take.outside_range_identical_to_parent, true);

    // The person sees what the outside agent did, in the chat.
    const notes = h.app.store.listMessages(pid).filter((m) => m.role === "event" && /outside agent/.test(m.text));
    assert.equal(notes.length, 2);

    // The live selection (sent by the web client as it changes) is what "selection" means.
    await fetch(`${h.url}/api/projects/${pid}/selection`, { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify({ selection: { startSec: 2, endSec: 5 } }) });
    const sel = await call(h.url, "repaint_section", {
      project_id: pid, take_id: repDone.data.take.id, start_seconds: 2, end_seconds: 5, range_source: "selection", lyrics: SONG.lyrics, change_summary: "selected",
    });
    assert.equal(sel.isError, false, sel.text);
    await call(h.url, "wait_for_job", { job_id: sel.data.job_id });

    const listed = await call(h.url, "list_projects", {});
    assert.equal(listed.data.projects[0].id, pid);
    assert.equal(listed.data.projects[0].finished_takes, 3);

    const missing = await call(h.url, "get_project_state", { project_id: "no-such-song" });
    assert.equal(missing.isError, true);
  } finally {
    await h.stop();
  }
});
