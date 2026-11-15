// The Anthropic implementation, exercised through the real @anthropic-ai/sdk
// against a local stub that speaks the Messages API's streaming wire format.
//
// This proves the plumbing (request shape, stream parsing, tool-call assembly,
// replay of stored content, error mapping). It does NOT prove that the real API
// accepts these requests: that needs a key and has not been done.

import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { toolDefinitions } from "../server/agent/tools.ts";
import { loadConfig } from "../server/config.ts";
import { AnthropicLlm } from "../server/llm/anthropic.ts";
import { LlmError, type LlmMessage } from "../server/llm/types.ts";

type Reply = { status?: number; json?: unknown; events?: Array<Record<string, unknown>> };

let server: http.Server;
let baseUrl: string;
const received: Array<{ path: string; headers: http.IncomingHttpHeaders; body: any }> = [];
const replies: Reply[] = [];

before(async () => {
  server = http.createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => {
      received.push({ path: req.url ?? "", headers: req.headers, body: JSON.parse(Buffer.concat(chunks).toString("utf8") || "null") });
      const reply = replies.shift() ?? { status: 500, json: { type: "error", error: { type: "api_error", message: "stub has no reply queued" } } };
      if (reply.events) {
        res.writeHead(200, { "content-type": "text/event-stream" });
        for (const e of reply.events) res.write(`event: ${e.type}\ndata: ${JSON.stringify(e)}\n\n`);
        res.end();
      } else {
        res.writeHead(reply.status ?? 200, { "content-type": "application/json" });
        res.end(JSON.stringify(reply.json));
      }
    });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

after(async () => {
  server.closeAllConnections();
  await new Promise((r) => server.close(r));
});

const start = (stop: null | string = null) => ({
  type: "message_start",
  message: { id: "msg_1", type: "message", role: "assistant", model: "claude-sonnet-5-5", content: [], stop_reason: stop, stop_sequence: null, usage: { input_tokens: 12, output_tokens: 1 } },
});
const end = (stop: string, extra: object = {}) => [
  { type: "message_delta", delta: { stop_reason: stop, stop_sequence: null, ...extra }, usage: { output_tokens: 40 } },
  { type: "message_stop" },
];

const SONG_INPUT = { title: "Tide", style_prompt: "slow folk", lyrics: "[verse]\nLine one\nLine \"two\"", bpm: 90, key: "A Minor", duration_seconds: 60 };

function toolTurn(): Reply {
  const json = JSON.stringify(SONG_INPUT);
  return {
    events: [
      start(),
      { type: "content_block_start", index: 0, content_block: { type: "thinking", thinking: "", signature: "" } },
      { type: "content_block_delta", index: 0, delta: { type: "signature_delta", signature: "sig-abc" } },
      { type: "content_block_stop", index: 0 },
      { type: "content_block_start", index: 1, content_block: { type: "text", text: "" } },
      { type: "content_block_delta", index: 1, delta: { type: "text_delta", text: "Starting " } },
      { type: "content_block_delta", index: 1, delta: { type: "text_delta", text: "your song." } },
      { type: "content_block_stop", index: 1 },
      { type: "content_block_start", index: 2, content_block: { type: "tool_use", id: "toolu_01", name: "generate_song", input: {} } },
      { type: "content_block_delta", index: 2, delta: { type: "input_json_delta", partial_json: json.slice(0, 25) } },
      { type: "content_block_delta", index: 2, delta: { type: "input_json_delta", partial_json: json.slice(25) } },
      { type: "content_block_stop", index: 2 },
      ...end("tool_use"),
    ],
  };
}

function textTurn(text: string, stop = "end_turn", extra: object = {}): Reply {
  return {
    events: [
      start(),
      { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
      { type: "content_block_delta", index: 0, delta: { type: "text_delta", text } },
      { type: "content_block_stop", index: 0 },
      ...end(stop, extra),
    ],
  };
}

function make(opts: { firstParty?: boolean; fallback?: boolean; model?: string; effort?: string | null } = {}) {
  const config = { ...loadConfig({}), anthropicApiKey: "sk-test-not-a-real-key", anthropicBaseUrl: baseUrl, model: opts.model ?? "claude-sonnet-5-5", effort: opts.effort === undefined ? "medium" : opts.effort, refusalFallback: opts.fallback ?? false };
  return new AnthropicLlm(config, { firstParty: opts.firstParty ?? false });
}

const tools = toolDefinitions(120);
const user: LlmMessage = { role: "user", text: "write a sea song\n\n<studio_state>\ncurrent take: none yet\n</studio_state>" };

test("anthropic: a streamed turn with text and a tool call is assembled, and the request has the expected shape", async () => {
  received.length = 0;
  replies.push(toolTurn());
  const deltas: string[] = [];
  const result = await make().streamTurn({ system: "SYSTEM PROMPT", tools, messages: [user], onText: (d) => deltas.push(d) });

  assert.deepEqual(deltas, ["Starting ", "your song."]);
  assert.equal(result.stopReason, "tool_use");
  assert.deepEqual(result.blocks, [
    { type: "text", text: "Starting your song." },
    { type: "tool_use", id: "toolu_01", name: "generate_song", input: SONG_INPUT },
  ]);
  assert.deepEqual(result.usage, { inputTokens: 12, outputTokens: 40 });
  // The raw content keeps the thinking block (with its signature) for replay.
  const raw = result.raw as any[];
  assert.deepEqual(raw.map((b) => b.type), ["thinking", "text", "tool_use"]);
  assert.equal(raw[0].signature, "sig-abc");

  const req = received[0];
  assert.equal(req.path, "/v1/messages");
  // SDK 1.x sends the API key as a bearer token.
  assert.equal(req.headers["authorization"], "Bearer sk-test-not-a-real-key");
  assert.ok(req.headers["anthropic-version"]);
  assert.equal(req.body.model, "claude-sonnet-5-5");
  assert.equal(req.body.stream, true);
  assert.equal(req.body.max_tokens, 32000);
  assert.deepEqual(req.body.system, [{ type: "text", text: "SYSTEM PROMPT", cache_control: { type: "ephemeral" } }]);
  assert.deepEqual(req.body.output_config, { effort: "medium" });
  assert.deepEqual(req.body.messages, [{ role: "user", content: user.text }]);
  assert.deepEqual(req.body.tools.map((t: any) => t.name), ["arrangement_history", "generate_song", "repaint_section", "get_project_state", "set_section_markers", "add_sound", "update_sound", "remove_sound", "set_track", "revert_to_take"]);
  assert.equal(req.body.tools[0].input_schema.type, "object");
  // Nothing the current models reject:
  assert.equal(req.body.thinking, undefined);
  assert.equal(req.body.tool_choice, undefined);
  assert.equal(req.body.temperature, undefined);
  // Behind a custom base URL the first-party extras are left out.
  assert.equal(req.body.fallbacks, undefined);
  assert.equal(req.body.cache_control, undefined);
  assert.equal(req.body.tools[0].eager_input_streaming, undefined);
  assert.equal(req.headers["anthropic-beta"], undefined);
});

test("anthropic: first-party request shape: eager tool input streaming, automatic caching, refusal fallback beta", async () => {
  received.length = 0;
  replies.push(textTurn("Hi."));
  const result = await make({ firstParty: true, fallback: true }).streamTurn({ system: "S", tools, messages: [user] });
  assert.deepEqual(result.blocks, [{ type: "text", text: "Hi." }]);
  assert.equal(result.stopReason, "end_turn");
  const req = received[0];
  assert.match(req.path, /^\/v1\/messages/);
  assert.equal(req.body.fallbacks, "default");
  assert.match(String(req.headers["anthropic-beta"]), /server-side-fallback-2026-07-01/);
  assert.deepEqual(req.body.cache_control, { type: "ephemeral" });
  assert.ok(req.body.tools.every((t: any) => t.eager_input_streaming === true));
  assert.equal(req.body.betas, undefined, "betas go in the header, not the body");

  // Effort can be switched off for models that do not take it.
  received.length = 0;
  replies.push(textTurn("Hi."));
  await make({ effort: null }).streamTurn({ system: "S", tools, messages: [user] });
  assert.equal(received[0].body.output_config, undefined);
});

test("anthropic: the next request replays the stored assistant content verbatim, then the tool results", async () => {
  received.length = 0;
  replies.push(toolTurn(), textTurn("Started. About a minute."));
  const llm = make();
  const first = await llm.streamTurn({ system: "S", tools, messages: [user] });
  const history: LlmMessage[] = [
    user,
    { role: "assistant", blocks: first.blocks, raw: first.raw, provider: "anthropic" },
    { role: "tool_results", results: [{ toolUseId: "toolu_01", content: '{"started":true}', isError: false }] },
  ];
  const second = await llm.streamTurn({ system: "S", tools, messages: history });
  assert.deepEqual(second.blocks, [{ type: "text", text: "Started. About a minute." }]);

  const sent = received[1].body.messages;
  assert.equal(sent.length, 3);
  assert.equal(sent[1].role, "assistant");
  assert.deepEqual(sent[1].content.map((b: any) => b.type), ["thinking", "text", "tool_use"]);
  assert.equal(sent[1].content[0].signature, "sig-abc", "the thinking block goes back unchanged");
  assert.deepEqual(sent[1].content[2].input, SONG_INPUT);
  assert.deepEqual(sent[2], { role: "user", content: [{ type: "tool_result", tool_use_id: "toolu_01", content: '{"started":true}' }] });
});

test("anthropic: turns stored by another provider are rebuilt from blocks; errors are flagged", async () => {
  received.length = 0;
  replies.push(textTurn("ok"));
  await make().streamTurn({
    system: "S",
    tools,
    messages: [
      user,
      { role: "assistant", blocks: [{ type: "text", text: "On it." }, { type: "tool_use", id: "fake_1", name: "get_project_state", input: {} }], raw: [{ whatever: true }], provider: "fake" },
      { role: "tool_results", results: [{ toolUseId: "fake_1", content: '{"error":"nope"}', isError: true }] },
    ],
  });
  const sent = received[0].body.messages;
  assert.deepEqual(sent[1].content, [
    { type: "text", text: "On it." },
    { type: "tool_use", id: "fake_1", name: "get_project_state", input: {} },
  ]);
  assert.deepEqual(sent[2].content, [{ type: "tool_result", tool_use_id: "fake_1", content: '{"error":"nope"}', is_error: true }]);
});

test("anthropic: a refusal returns no content and a note; max_tokens is passed through", async () => {
  replies.push({
    events: [
      start(),
      { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
      { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "Partial out" } },
      { type: "content_block_stop", index: 0 },
      ...end("refusal", { stop_details: { type: "refusal", category: "cyber", explanation: "x" } }),
    ],
  });
  const refused = await make().streamTurn({ system: "S", tools, messages: [user] });
  assert.equal(refused.stopReason, "refusal");
  assert.deepEqual(refused.blocks, [], "partial output of a refused turn is discarded");
  assert.equal(refused.raw, undefined);
  assert.match(refused.note!, /declined this request/);

  replies.push(textTurn("cut", "max_tokens"));
  assert.equal((await make().streamTurn({ system: "S", tools, messages: [user] })).stopReason, "max_tokens");
});

test("anthropic: API errors become messages a user can act on", async () => {
  const fails = async (reply: Reply, re: RegExp, model?: string) => {
    replies.push(reply);
    await assert.rejects(make({ model }).streamTurn({ system: "S", tools, messages: [user] }), (e: unknown) => {
      assert.ok(e instanceof LlmError, `expected LlmError, got ${e}`);
      assert.match(e.message, re);
      return true;
    });
  };
  await fails({ status: 401, json: { type: "error", error: { type: "authentication_error", message: "invalid x-api-key" } } }, /rejected the API key.*ANTHROPIC_API_KEY/);
  await fails({ status: 404, json: { type: "error", error: { type: "not_found_error", message: "model: nope" } } }, /model "claude-nope" was not found.*SONG_STUDIO_MODEL/, "claude-nope");
  await fails({ status: 400, json: { type: "error", error: { type: "invalid_request_error", message: "max_tokens: too large" } } }, /rejected the request: .*max_tokens: too large/);
  await fails({ status: 403, json: { type: "error", error: { type: "permission_error", message: "no access" } } }, /not allowed to use/);
});

test("anthropic: reports a missing key before any request is made", () => {
  const config = { ...loadConfig({}), anthropicApiKey: null };
  const saved = process.env.ANTHROPIC_AUTH_TOKEN;
  delete process.env.ANTHROPIC_AUTH_TOKEN;
  try {
    const savedKey = process.env.ANTHROPIC_API_KEY;
    process.env.ANTHROPIC_API_KEY = "placeholder-so-the-sdk-constructs";
    try {
      assert.match(new AnthropicLlm(config).problem()!, /ANTHROPIC_API_KEY is not set/);
    } finally {
      if (savedKey === undefined) delete process.env.ANTHROPIC_API_KEY;
      else process.env.ANTHROPIC_API_KEY = savedKey;
    }
    assert.equal(make().problem(), null);
  } finally {
    if (saved !== undefined) process.env.ANTHROPIC_AUTH_TOKEN = saved;
  }
});

test("config: defaults, and when the refusal fallback is on", () => {
  const d = loadConfig({});
  assert.equal(d.host, "127.0.0.1");
  assert.equal(d.port, 8787);
  assert.equal(d.acestepUrl, "http://127.0.0.1:8001");
  assert.equal(d.llm, "anthropic");
  assert.equal(d.model, "claude-sonnet-5-5");
  assert.equal(d.effort, "medium");
  assert.equal(d.maxDurationSec, 120);
  assert.equal(d.refusalFallback, true);
  assert.equal(loadConfig({ ANTHROPIC_BASE_URL: "http://gateway.local" }).refusalFallback, false);
  assert.equal(loadConfig({ SONG_STUDIO_REFUSAL_FALLBACK: "off" }).refusalFallback, false);
  assert.equal(loadConfig({ SONG_STUDIO_MODEL: "claude-haiku-5-5" }).refusalFallback, false, "no server-side fallback exists for Haiku");
  assert.equal(loadConfig({ SONG_STUDIO_EFFORT: "none" }).effort, null);
  assert.equal(loadConfig({ SONG_STUDIO_LLM: "fake", HOST: "0.0.0.0", PORT: "9000", ACESTEP_URL: "http://x:1/" }).acestepUrl, "http://x:1");
  assert.throws(() => loadConfig({ SONG_STUDIO_LLM: "gpt" }), /must be "anthropic" or "fake"/);
});
