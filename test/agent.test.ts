// The agent loop and its tools, driven by the scripted fake LLM, against the
// real studio service and the mock ACE-Step server.

import { test } from "node:test";
import assert from "node:assert/strict";
import { AgentBusyError } from "../server/agent/loop.ts";
import { buildSystemPrompt } from "../server/agent/prompt.ts";
import { projectStateForAgent, toolDefinitions, validateAgainstSchema } from "../server/agent/tools.ts";
import { FakeLlm, parseStudioContext } from "../server/llm/fake.ts";
import { LlmError, type LlmClient, type LlmTurnRequest, type LlmTurnResult } from "../server/llm/types.ts";
import type { ChatMessage, StudioEvent } from "../server/types.ts";
import { waitFor } from "./helpers.ts";
import { SONG, startHarness } from "./harness.ts";

const roles = (messages: ChatMessage[]) => messages.map((m) => m.role);
const toolNames = (messages: ChatMessage[]) =>
  messages.flatMap((m) => (m.role === "assistant" ? m.blocks.filter((b) => b.type === "tool_use").map((b: any) => b.name) : []));
const lastText = (messages: ChatMessage[]) => {
  const a = messages.filter((m) => m.role === "assistant").at(-1) as any;
  return a?.blocks.find((b: any) => b.type === "text")?.text ?? "";
};
const toolResults = (messages: ChatMessage[]) => messages.flatMap((m) => (m.role === "tool" ? m.results : []));

test("agent: the main flow: generate a song, select a range, repaint it, go back", async () => {
  const h = await startHarness();
  try {
    const project = h.app.studio.createProject();

    // 1. Generate.
    let messages = await h.say(project.id, "Write a 20 second folk song about paper boats");
    assert.deepEqual(roles(messages), ["user", "assistant", "tool", "assistant", "event"]);
    assert.deepEqual(toolNames(messages), ["generate_song"]);
    const started = JSON.parse(toolResults(messages)[0].content);
    assert.equal(started.started, true);
    assert.match(started.note, /about a minute/);
    assert.match(lastText(messages), /I've started generating “Paper Boats”/);
    const take1 = h.takes(project.id)[0];
    assert.equal(take1.status, "done");
    assert.equal(take1.id, started.take_id);
    assert.equal(take1.durationSec, 20);
    assert.equal(take1.params.title, "Paper Boats");

    // 2. Ask for a change without selecting anything: the agent must ask, not guess.
    messages = await h.say(project.id, "Rewrite the lyrics in the second half");
    assert.equal(h.takes(project.id).length, 1, "no take may be created without a range");
    assert.deepEqual(toolNames(messages), ["generate_song"], "no tool call for an edit without a range");
    assert.match(lastText(messages), /Drag across it on the waveform/);

    // 3. Same request with a selection: reads the state, then repaints exactly the selection.
    messages = await h.say(project.id, "Rewrite the lyrics in the part I selected", { startSec: 6.004, endSec: 11.5 });
    assert.deepEqual(toolNames(messages), ["generate_song", "get_project_state", "repaint_section"]);
    const takes = h.takes(project.id);
    assert.equal(takes.length, 2);
    const take2 = takes[1];
    assert.equal(take2.status, "done");
    assert.equal(take2.parentTakeId, take1.id);
    assert.deepEqual(take2.params.repaint, { startSec: 6.004, endSec: 11.5 });
    assert.equal(take2.checks!.status, "verified");
    assert.equal(take2.checks!.bitIdenticalOutside, true);
    assert.equal(take2.changeSummary, "Rewrote the lyrics in the selected part");
    assert.notEqual(take2.params.lyrics, take1.params.lyrics);
    assert.match(take2.params.lyrics, /\[verse\]\nPaper boats along the gutter stream/, "the rest of the lyrics are kept");
    assert.match(take2.params.lyrics, /New words for the part you picked/);
    assert.equal(h.app.store.getProject(project.id)!.currentTakeId, take2.id);
    assert.match(lastText(messages), /changes only 6\.0–11\.5 s/);
    assert.match((messages.at(-1) as any).text, /Take 2 is ready\. Verified/);

    // 4. Go back.
    messages = await h.say(project.id, "Actually, go back to take 1");
    assert.deepEqual(toolNames(messages).slice(-2), ["get_project_state", "revert_to_take"]);
    assert.equal(h.app.store.getProject(project.id)!.currentTakeId, take1.id);
    assert.equal(h.takes(project.id).length, 2, "reverting deletes nothing");
  } finally {
    await h.stop();
  }
});

test("agent: section markers: saved from what the user says, then usable by name", async () => {
  const h = await startHarness();
  try {
    const project = h.app.studio.createProject();
    await h.say(project.id, "make a 20 second song");
    let messages = await h.say(project.id, "The chorus is 8 to 14 seconds");
    assert.deepEqual(toolNames(messages).slice(-2), ["get_project_state", "set_section_markers"]);
    assert.deepEqual(h.app.studio.markers(project.id), [{ label: "chorus", startSec: 8, endSec: 14 }]);

    messages = await h.say(project.id, "the verse is 0 to 8");
    assert.deepEqual(
      h.app.studio.markers(project.id).map((m) => m.label),
      ["verse", "chorus"],
      "adding a marker keeps the existing ones",
    );

    // No selection this time: the marker name supplies the range.
    messages = await h.say(project.id, "Make the chorus a guitar solo");
    const take = h.takes(project.id).at(-1)!;
    assert.equal(take.kind, "repaint");
    assert.deepEqual(take.params.repaint, { startSec: 8, endSec: 14 });
    assert.match(take.params.lyrics, /\[guitar solo\]/);
    assert.match(take.params.stylePrompt, /guitar solo/);
    assert.equal(take.checks!.status, "verified");
    const call = (messages.filter((m) => m.role === "assistant").at(-2) as any).blocks.find((b: any) => b.type === "tool_use");
    assert.equal(call.input.range_source, "marker");
    assert.equal(call.input.marker_label, "chorus");
  } finally {
    await h.stop();
  }
});

test("agent: repaint_section rejects a range that does not match its declared source", async () => {
  const lyrics = SONG.lyrics;
  const h = await startHarness({
    script: [
      // turn 1: claims "selection" but there is none
      (req) => ({ toolCalls: [{ name: "repaint_section", input: { take_id: currentTake(req), start_seconds: 2, end_seconds: 5, range_source: "selection", lyrics, change_summary: "x" } }] }),
      { text: "asked" },
      // turn 2: there is a selection (3-6) but the model passes other numbers
      (req) => ({ toolCalls: [{ name: "repaint_section", input: { take_id: currentTake(req), start_seconds: 2, end_seconds: 8, range_source: "selection", lyrics, change_summary: "x" } }] }),
      { text: "asked again" },
      // turn 3: unknown marker
      (req) => ({ toolCalls: [{ name: "repaint_section", input: { take_id: currentTake(req), start_seconds: 2, end_seconds: 8, range_source: "marker", marker_label: "bridge", lyrics, change_summary: "x" } }] }),
      { text: "no such marker" },
      // turn 4: a marker exists (2-8) but the numbers are off
      (req) => ({ toolCalls: [{ name: "repaint_section", input: { take_id: currentTake(req), start_seconds: 3, end_seconds: 8, range_source: "marker", marker_label: "Chorus", lyrics, change_summary: "x" } }] }),
      { text: "mismatch" },
      // turn 5: numbers within tolerance of the selection -> accepted, snapped to the selection
      (req) => ({ toolCalls: [{ name: "repaint_section", input: { take_id: currentTake(req), start_seconds: 3.0, end_seconds: 6.03, range_source: "selection", lyrics, change_summary: "ok" } }] }),
      { text: "started" },
      // turn 6: the user typed the numbers
      (req) => ({ toolCalls: [{ name: "repaint_section", input: { take_id: currentTake(req), start_seconds: 1, end_seconds: 2.5, range_source: "user_stated", lyrics, change_summary: "typed" } }] }),
      { text: "started" },
    ],
  });
  const currentTake = (req: LlmTurnRequest) => parseStudioContext((req.messages.filter((m) => m.role === "user").at(-1) as any).text).currentTakeId;
  try {
    const project = h.app.studio.createProject();
    await h.app.studio.startGenerate(project.id, SONG);
    await h.settle();
    const errorOf = (messages: ChatMessage[]) => {
      const r = toolResults(messages).at(-1)!;
      return { isError: r.isError, text: JSON.parse(r.content).error as string };
    };

    let e = errorOf(await h.say(project.id, "change it"));
    assert.equal(e.isError, true);
    assert.match(e.text, /There is no selection on the waveform/);

    e = errorOf(await h.say(project.id, "change it", { startSec: 3, endSec: 6 }));
    assert.match(e.text, /does not match the person's selection, which is 3–6 s/);

    e = errorOf(await h.say(project.id, "change the bridge"));
    assert.match(e.text, /no section marker called "bridge". Saved markers: none/);

    h.app.studio.setMarkers(project.id, [{ label: "chorus", startSec: 2, endSec: 8 }]);
    e = errorOf(await h.say(project.id, "change the chorus"));
    assert.match(e.text, /does not match marker "chorus", which is 2–8 s/);
    assert.equal(h.takes(project.id).length, 1, "four rejected attempts created nothing");
    assert.equal(h.mock.stats.submitted, 1);

    await h.say(project.id, "change it", { startSec: 3, endSec: 6.01 });
    assert.deepEqual(h.takes(project.id).at(-1)!.params.repaint, { startSec: 3, endSec: 6.01 }, "the server's selection is used, not the model's rounding");

    await h.say(project.id, "change 1 to 2.5 seconds");
    assert.deepEqual(h.takes(project.id).at(-1)!.params.repaint, { startSec: 1, endSec: 2.5 });
    assert.equal(h.takes(project.id).length, 3);
  } finally {
    await h.stop();
  }
});

test("agent: invalid tool input and unknown tools come back as errors the model can act on", async () => {
  const h = await startHarness({
    script: [
      { toolCalls: [{ name: "generate_song", input: { title: "No lyrics", style_prompt: "x", bpm: 100, key: "C Major", duration_seconds: 20 } }] },
      { toolCalls: [{ name: "generate_song", input: { title: "T", style_prompt: "x", lyrics: "[instrumental]", bpm: "fast", key: "C Major", duration_seconds: 20 } }] },
      { toolCalls: [{ name: "delete_everything", input: {} }] },
      { toolCalls: [{ name: "generate_song", input: { title: "T", style_prompt: "x", lyrics: "[instrumental]", bpm: 100, key: "C Major", duration_seconds: 300 } }] },
      { toolCalls: [{ name: "revert_to_take", input: { take_id: "t_missing" } }] },
      { text: "I give up." },
    ],
  });
  try {
    const project = h.app.studio.createProject();
    const messages = await h.say(project.id, "go");
    const results = toolResults(messages);
    assert.equal(results.length, 5);
    assert.ok(results.every((r) => r.isError));
    assert.match(results[0].content, /Invalid tool input: input\.lyrics is required\. Nothing was done/);
    assert.match(results[1].content, /input\.bpm must be a whole number/);
    assert.match(results[2].content, /Unknown tool \\"delete_everything\\"/);
    assert.match(results[3].content, /over the current limit of 120 s/);
    assert.match(results[4].content, /take t_missing does not exist/);
    assert.equal(lastText(messages), "I give up.");
    assert.equal(h.takes(project.id).length, 0);
  } finally {
    await h.stop();
  }
});

test("agent: when the model server is down the tool says so and nothing is started", async () => {
  const h = await startHarness({ modelServerDown: true });
  try {
    const project = h.app.studio.createProject();
    const messages = await h.say(project.id, "write a song about rain");
    const r = toolResults(messages)[0];
    assert.equal(r.isError, true);
    assert.equal(JSON.parse(r.content).code, "model_server_unreachable");
    assert.match(lastText(messages), /That didn't work: The music model server is not reachable/);
    assert.equal(h.takes(project.id).length, 0);
  } finally {
    await h.stop();
  }
});

test("agent: history is replayed append-only and verbatim, with the selection and state attached to each user message", async () => {
  const llm = new FakeLlm({ wordDelayMs: 0 });
  const h = await startHarness({ llm });
  try {
    const project = h.app.studio.createProject();
    await h.say(project.id, "write a 20 second song about rivers");
    h.app.studio.setMarkers(project.id, [{ label: "chorus", startSec: 8, endSec: 14 }]);
    await h.say(project.id, "rewrite the part I selected", { startSec: 2, endSec: 5 });

    const first = llm.requests[0];
    assert.equal(first.messages.length, 1);
    const firstUser = (first.messages[0] as any).text as string;
    assert.match(firstUser, /^write a 20 second song about rivers\n\n<studio_state>\ncurrent take: none yet\nselection on the waveform: none\nsection markers: none\njobs in progress: none\n<\/studio_state>$/);

    const last = llm.requests.at(-1)!;
    // Every earlier request's messages are an exact prefix of the next one's.
    for (let i = 1; i < llm.requests.length; i++) {
      const prev = llm.requests[i - 1].messages;
      assert.deepEqual(llm.requests[i].messages.slice(0, prev.length), prev, `request ${i} rewrote history`);
    }
    assert.deepEqual(
      last.messages.map((m) => m.role),
      ["user", "assistant", "tool_results", "assistant", "user", "assistant", "tool_results", "assistant", "tool_results"],
    );
    const take1 = h.takes(project.id)[0];
    const secondUser = (last.messages[4] as any).text as string;
    assert.ok(secondUser.includes(`current take: ${take1.id} (take 1, generate, 20.0 s, "Rivers")`), secondUser);
    assert.ok(secondUser.includes("selection on the waveform: 2.00–5.00 s"));
    assert.ok(secondUser.includes('section markers: "chorus" 8.00–14.00 s'));
    // Tool results answer the tool_use ids of the assistant message right before them.
    for (let i = 0; i < last.messages.length; i++) {
      const m = last.messages[i];
      if (m.role !== "tool_results") continue;
      const prev = last.messages[i - 1] as any;
      assert.equal(prev.role, "assistant");
      assert.deepEqual(m.results.map((r) => r.toolUseId), prev.blocks.filter((b: any) => b.type === "tool_use").map((b: any) => b.id));
    }
    // The provider's raw content is stored and handed back untouched.
    const assistant = last.messages[1] as any;
    assert.equal(assistant.provider, "fake");
    assert.deepEqual(assistant.raw, assistant.blocks);
    // The same system prompt and tools every time (cache-friendly).
    assert.ok(llm.requests.every((r) => r.system === first.system));
    assert.deepEqual(last.tools.map((t) => t.name), ["generate_song", "repaint_section", "get_project_state", "set_section_markers", "revert_to_take"]);
  } finally {
    await h.stop();
  }
});

test("agent: text is streamed as deltas and the turn is bracketed by started/ended events", async () => {
  const h = await startHarness({ script: [{ text: "Hello there, this is streamed." }] });
  try {
    const project = h.app.studio.createProject();
    const events: StudioEvent[] = [];
    h.app.bus.subscribe(project.id, (e) => events.push(e));
    await h.say(project.id, "hi");
    const types = events.map((e) => e.type);
    assert.equal(types[0], "chat.message"); // the user's message
    assert.equal(types[1], "chat.turn");
    assert.equal((events[1] as any).state, "started");
    const deltas = events.filter((e) => e.type === "chat.delta").map((e: any) => e.text);
    assert.ok(deltas.length > 3);
    assert.equal(deltas.join(""), "Hello there, this is streamed.");
    const ended = events.findLast((e) => e.type === "chat.turn") as any;
    assert.equal(ended.state, "ended");
    assert.equal(ended.error, undefined);
    assert.ok(types.indexOf("chat.delta") < types.lastIndexOf("chat.message"));
  } finally {
    await h.stop();
  }
});

test("agent: one turn at a time per project; a failing model produces a visible error and the next message works", async () => {
  let calls = 0;
  let release: () => void = () => {};
  const llm: LlmClient = {
    provider: "fake",
    model: "test",
    problem: () => null,
    async streamTurn(): Promise<LlmTurnResult> {
      calls++;
      if (calls === 1) {
        await new Promise<void>((r) => (release = r));
        throw new LlmError("The chat model rejected the API key.");
      }
      return { blocks: [{ type: "text", text: "Back again." }], stopReason: "end_turn" };
    },
  };
  const h = await startHarness({ llm });
  try {
    const project = h.app.studio.createProject();
    const other = h.app.studio.createProject();
    h.app.agent.send(project.id, "first", null);
    assert.equal(h.app.agent.isBusy(project.id), true);
    assert.throws(() => h.app.agent.send(project.id, "second", null), AgentBusyError);
    const res = await fetch(`${h.url}/api/projects/${project.id}/chat`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ text: "third" }) });
    assert.equal(res.status, 409);
    await res.arrayBuffer();
    assert.equal(h.app.agent.isBusy(other.id), false, "another project is not blocked");

    const events: StudioEvent[] = [];
    h.app.bus.subscribe(project.id, (e) => events.push(e));
    release();
    await h.app.agent.whenIdle(project.id);
    let messages = h.app.store.listMessages(project.id);
    assert.deepEqual(roles(messages), ["user", "event"]);
    assert.deepEqual({ kind: (messages[1] as any).kind, text: (messages[1] as any).text }, { kind: "error", text: "The chat model rejected the API key." });
    assert.equal((events.findLast((e) => e.type === "chat.turn") as any).error, "The chat model rejected the API key.");

    messages = await h.say(project.id, "again");
    assert.equal(lastText(messages), "Back again.");
  } finally {
    await h.stop();
  }
});

test("agent: a model that never stops calling tools is cut off", async () => {
  const h = await startHarness({ script: Array.from({ length: 12 }, () => ({ toolCalls: [{ name: "get_project_state", input: {} }] })) });
  try {
    const project = h.app.studio.createProject();
    const messages = await h.say(project.id, "loop forever");
    assert.equal(toolNames(messages).length, 8);
    assert.match((messages.at(-1) as any).text, /kept calling tools without finishing/);
  } finally {
    await h.stop();
  }
});

test("agent: refusals and truncated tool calls never run tools", async () => {
  const results: LlmTurnResult[] = [
    { blocks: [], stopReason: "refusal", note: "The chat model declined this request (category: cyber). Try rephrasing it." },
    {
      // Cut off at max_tokens in the middle of a tool call: the input parses but is incomplete.
      blocks: [{ type: "tool_use", id: "tu_1", name: "generate_song", input: { title: "Cut", style_prompt: "x", lyrics: "[verse]\nhalf a li", bpm: 100, key: "C Major", duration_seconds: 20 } }],
      stopReason: "max_tokens",
    },
    { blocks: [{ type: "text", text: "Fine now." }], stopReason: "end_turn" },
  ];
  const llm: LlmClient = { provider: "fake", model: "test", problem: () => null, streamTurn: async () => results.shift()! };
  const h = await startHarness({ llm });
  try {
    const project = h.app.studio.createProject();
    let messages = await h.say(project.id, "one");
    assert.deepEqual(roles(messages), ["user", "event"]);
    assert.match((messages[1] as any).text, /declined this request \(category: cyber\)/);

    messages = await h.say(project.id, "two");
    assert.equal(h.takes(project.id).length, 0, "a truncated tool call must not run");
    assert.equal(h.mock.stats.submitted, 0);
    const r = toolResults(messages).at(-1)!;
    assert.equal(r.isError, true);
    assert.match(r.content, /cut off before this tool call was complete/);
    assert.match((messages.at(-1) as any).text, /cut off mid-action, so nothing was started/);

    // The history stays well-formed (tool_use answered), so the conversation continues.
    messages = await h.say(project.id, "three");
    assert.equal(lastText(messages), "Fine now.");
  } finally {
    await h.stop();
  }
});

test("agent: a tool call interrupted by a restart is closed off so the history stays valid", async () => {
  const llm = new FakeLlm({ wordDelayMs: 0, script: [{ text: "Carrying on." }] });
  const h = await startHarness({ llm });
  try {
    const project = h.app.studio.createProject();
    h.app.store.insertMessage(project.id, { role: "user", text: "make a song", selection: null }, { text: "make a song" });
    h.app.store.insertMessage(project.id, { role: "assistant", blocks: [{ type: "tool_use", id: "tu_lost", name: "generate_song", input: {} }], stopReason: "tool_use" });
    await h.say(project.id, "hello?");
    const sent = llm.requests[0].messages;
    assert.deepEqual(sent.map((m) => m.role), ["user", "assistant", "tool_results", "user"]);
    const closing = sent[2] as any;
    assert.equal(closing.results[0].toolUseId, "tu_lost");
    assert.equal(closing.results[0].isError, true);
    assert.match(closing.results[0].content, /interrupted before it ran/);
  } finally {
    await h.stop();
  }
});

test("agent: chat over HTTP and SSE: the browser's view of a turn", async () => {
  const h = await startHarness({ mockDelayMs: 200 });
  try {
    const created = (await (await fetch(`${h.url}/api/projects`, { method: "POST" })).json()) as any;
    const id = created.project.id;
    const events: StudioEvent[] = [];
    const ctrl = new AbortController();
    const sse = await fetch(`${h.url}/api/projects/${id}/events`, { signal: ctrl.signal });
    assert.match(sse.headers.get("content-type")!, /text\/event-stream/);
    const reader = (async () => {
      const dec = new TextDecoder();
      let buf = "";
      try {
        for await (const chunk of sse.body as any) {
          buf += dec.decode(chunk, { stream: true });
          let i;
          while ((i = buf.indexOf("\n\n")) >= 0) {
            const frame = buf.slice(0, i);
            buf = buf.slice(i + 2);
            const data = frame.split("\n").find((l) => l.startsWith("data:"))?.slice(5).trim();
            if (data) events.push(JSON.parse(data));
          }
        }
      } catch {
        /* aborted */
      }
    })();
    await waitFor(() => events.length > 0, 3000, "first SSE event");

    const res = await fetch(`${h.url}/api/projects/${id}/chat`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ text: "write a 20 second song about the sea", selection: null }),
    });
    assert.equal(res.status, 202);
    await res.arrayBuffer();
    await waitFor(() => events.some((e) => e.type === "chat.message" && e.message.role === "event"), 5000, "take ready event");
    ctrl.abort();
    await reader;

    const jobs = events.filter((e) => e.type === "job").map((e: any) => e.job);
    assert.equal(jobs[0].status, "queued");
    assert.ok(jobs.some((j) => j.status === "running" && j.progress > 0 && j.stage), "progress was forwarded");
    assert.equal(jobs.at(-1).status, "done");
    assert.ok(events.some((e) => e.type === "chat.delta"));
    const state = (await (await fetch(`${h.url}/api/projects/${id}`)).json()) as any;
    assert.equal(state.takes.length, 1);
    assert.equal(state.takes[0].status, "done");
    assert.deepEqual(state.messages.map((m: any) => m.role), ["user", "assistant", "tool", "assistant", "event"]);
    assert.equal(state.messages[1].llm, undefined, "provider payloads are not sent to the browser");
  } finally {
    await h.stop();
  }
});

test("agent: tool schemas and the system prompt", () => {
  const defs = toolDefinitions(120);
  for (const d of defs) {
    assert.equal((d.inputSchema as any).type, "object");
    assert.ok(d.description.length > 80, `${d.name} needs a real description`);
  }
  const repaint = defs.find((d) => d.name === "repaint_section")!.inputSchema;
  const good = { take_id: "t_1", start_seconds: 1, end_seconds: 2, range_source: "selection", lyrics: "x", change_summary: "y" };
  assert.equal(validateAgainstSchema(repaint, good), null);
  assert.match(validateAgainstSchema(repaint, { ...good, range_source: "guess" })!, /must be one of: selection, marker, detected_section, user_stated/);
  assert.match(validateAgainstSchema(repaint, { ...good, extra: 1 })!, /input\.extra is not a known parameter/);
  assert.match(validateAgainstSchema(repaint, { ...good, start_seconds: "1" })!, /input\.start_seconds must be a number/);
  assert.match(validateAgainstSchema(repaint, "nope")!, /must be an object/);
  const markers = defs.find((d) => d.name === "set_section_markers")!.inputSchema;
  assert.match(validateAgainstSchema(markers, { markers: [{ label: "a", start_seconds: 1 }] })!, /input\.markers\[0\]\.end_seconds is required/);

  const prompt = buildSystemPrompt({ maxDurationSec: 120, minDurationSec: 10, minRepaintSec: 0.5 });
  assert.equal(prompt, buildSystemPrompt({ maxDurationSec: 120, minDurationSec: 10, minRepaintSec: 0.5 }), "the prompt must be byte-stable");
  for (const must of ["never guess", "complete lyrics", "about a minute", "bit-for-bit", "<studio_state>", "between 10 and 120"]) {
    assert.ok(prompt.includes(must), `system prompt lost: ${must}`);
  }
  assert.ok(!/\d{4}-\d{2}-\d{2}/.test(prompt), "no dates in the system prompt (it would break caching)");
});

test("agent: heard sections reach the model and can be repainted by name; the range is checked against them", async () => {
  const lyrics = SONG.lyrics;
  let seen = "";
  const h = await startHarness({
    script: [
      (req) => {
        seen = (req.messages.filter((m) => m.role === "user").at(-1) as any).text;
        return { toolCalls: [{ name: "repaint_section", input: { take_id: currentTake(req), start_seconds: 1, end_seconds: 3, range_source: "detected_section", section_label: "bridge", lyrics, change_summary: "x" } }] };
      },
      { text: "no bridge" },
      (req) => ({ toolCalls: [{ name: "repaint_section", input: { take_id: currentTake(req), start_seconds: 1, end_seconds: 3, range_source: "detected_section", section_label: "chorus", lyrics, change_summary: "x" } }] }),
      { text: "mismatch" },
      (req) => {
        const chorus = /"chorus" (\d+\.\d+)–(\d+\.\d+) s/.exec((req.messages.filter((m) => m.role === "user").at(-1) as any).text)!;
        return { toolCalls: [{ name: "repaint_section", input: { take_id: currentTake(req), start_seconds: Number(chorus[1]), end_seconds: Number(chorus[2]), range_source: "detected_section", section_label: "Chorus", lyrics, change_summary: "bigger chorus" } }] };
      },
      { text: "started the chorus" },
    ],
  });
  const currentTake = (req: LlmTurnRequest) => parseStudioContext((req.messages.filter((m) => m.role === "user").at(-1) as any).text).currentTakeId;
  try {
    const project = h.app.studio.createProject();
    const gen = await h.app.studio.startGenerate(project.id, SONG);
    await h.settle();
    const timing = h.app.studio.timing(project.id, gen.take.id)!;
    assert.deepEqual(timing.sections.map((s) => s.label), ["verse", "chorus", "outro"]);
    const chorus = timing.sections[1];

    let msgs = await h.say(project.id, "make the bridge bigger");
    assert.match(seen, /sections heard in the current take: "verse" [\d.]+–[\d.]+ s; "chorus"/);
    assert.match(seen, /12 of 12 lyric words heard/);
    assert.match(JSON.parse(toolResults(msgs).at(-1)!.content).error, /No section called "bridge" was heard in take 1. Heard sections: "verse", "chorus", "outro"/);

    msgs = await h.say(project.id, "make the chorus bigger");
    assert.match(JSON.parse(toolResults(msgs).at(-1)!.content).error, /does not match the heard section "chorus"/);
    assert.equal(h.takes(project.id).length, 1);

    await h.say(project.id, "make the chorus bigger");
    const take = h.takes(project.id).at(-1)!;
    assert.deepEqual(take.params.repaint, { startSec: chorus.startSec, endSec: chorus.endSec });
    assert.equal(take.checks!.bitIdenticalOutside, true);

    const state = projectStateForAgent(h.app.studio, project.id) as any;
    assert.equal(state.current_take.heard_in_audio.status, "analysed");
    assert.equal(state.current_take.heard_in_audio.lines[0].text, "Paper boats along the gutter stream");
    assert.equal(state.takes[1].lyric_words_heard, "12/12");
  } finally {
    await h.stop();
  }
});

test("agent: without speech recognition the state says so and detected_section is refused", async () => {
  const h = await startHarness({
    transcriber: null,
    script: [
      (req) => ({ toolCalls: [{ name: "repaint_section", input: { take_id: parseStudioContext((req.messages.at(-1) as any).text).currentTakeId, start_seconds: 1, end_seconds: 3, range_source: "detected_section", section_label: "chorus", lyrics: SONG.lyrics, change_summary: "x" } }] }),
      { text: "ok" },
    ],
  });
  try {
    const project = h.app.studio.createProject();
    await h.app.studio.startGenerate(project.id, SONG);
    await h.settle();
    const msgs = await h.say(project.id, "redo the chorus");
    const user = msgs.find((m) => m.role === "user")!;
    assert.ok(user);
    assert.match(JSON.parse(toolResults(msgs).at(-1)!.content).error, /has not been analysed yet/);
  } finally {
    await h.stop();
  }
});
