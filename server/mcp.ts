// The studio as an MCP server, so any agent (Claude Code, another editor, a
// script) can drive it. Served by the app itself over Streamable HTTP at
// POST /mcp, so it shares the one job queue, the same validation, and the same
// "never guess a time range" guard as the built-in assistant. Stateless: no
// sessions, plain JSON responses, no server-initiated messages.
//
//   claude mcp add --transport http song-studio http://127.0.0.1:8787/mcp

import type { Context } from "hono";
import { executeTool, projectStateForAgent, toolDefinitions } from "./agent/tools.ts";
import type { LlmToolDef } from "./llm/types.ts";
import { type Studio, StudioError } from "./studio.ts";
import type { Job } from "./types.ts";

const SUPPORTED_VERSIONS = ["2025-11-25", "2025-06-18", "2025-03-26", "2024-11-05"];
const DEFAULT_VERSION = "2025-06-18";

const INSTRUCTIONS = `Song Studio is a local music studio. A song lives in a project folder (song.json, lyrics.md, takes/*.wav, history.jsonl); get_project_state returns the folder's path, and you may read those files directly.

Every change makes a new immutable take. generate_song makes a new song; repaint_section regenerates one time range of a finished take and the app verifies that everything outside the range is bit-identical to the parent. Both only start a job (about a minute each, one at a time); call wait_for_job to block until it is done.

Never estimate a time range. A repaint range must come from the person's waveform selection, a saved section marker, a section the app heard in that take (speech recognition aligns the lyrics after each take), or numbers the person gave you. The app rejects a range that does not match its stated source.

Lyrics passed to a tool are always the complete lyrics of the whole song. Keep to about four sung words per bar; the app rejects lyrics that do not fit the duration.

The person sees everything you do in the studio's web app as it happens.`;

interface McpTool {
  name: string;
  description: string;
  inputSchema: Record<string, any>;
  run(studio: Studio, args: any): Promise<unknown>;
}

const PROJECT_ID = { type: "string", description: "The project's id (its folder name), from list_projects." };

function forOutsideAgents(text: string): string {
  return text
    .replace(/shown in <studio_state>/g, "returned by get_project_state")
    .replace(/listed in <studio_state>/g, "returned by get_project_state")
    .replace(/<studio_state>/g, "get_project_state");
}

function wrapAgentTool(def: LlmToolDef, defs: LlmToolDef[]): McpTool {
  const schema = def.inputSchema as Record<string, any>;
  const properties: Record<string, any> = { project_id: PROJECT_ID };
  for (const [k, v] of Object.entries(schema.properties ?? {})) {
    properties[k] = typeof (v as any).description === "string" ? { ...(v as any), description: forOutsideAgents((v as any).description) } : v;
  }
  return {
    name: def.name,
    description: forOutsideAgents(def.description),
    inputSchema: { ...schema, required: ["project_id", ...(schema.required ?? [])], properties },
    async run(studio, args) {
      const { project_id, ...rest } = args ?? {};
      if (typeof project_id !== "string" || !project_id) throw new StudioError("invalid", "project_id is required");
      studio.project(project_id);
      const out = await executeTool(studio, project_id, defs, def.name, rest);
      const parsed = JSON.parse(out.content);
      if (out.isError) throw new StudioError("invalid", parsed.error ?? out.content);
      if (def.name === "generate_song" || def.name === "repaint_section") {
        studio.note(project_id, `An outside agent started take ${parsed.take_number} (${rest.change_summary ?? rest.title ?? def.name}).`);
      }
      return parsed;
    },
  };
}

function jobOut(studio: Studio, job: Job) {
  const take = studio.store.getTake(job.takeId);
  const timing = take?.status === "done" ? studio.store.readTiming(take) : null;
  return {
    job_id: job.id,
    status: job.status,
    progress: job.progress,
    stage: job.stage,
    error: job.error,
    take: take
      ? {
          id: take.id,
          number: take.seq,
          status: take.status,
          duration_seconds: take.durationSec,
          audio_file: take.status === "done" ? studio.store.takeAudioPath(take.id) : null,
          ...(take.checks ? { outside_range_identical_to_parent: take.checks.status === "verified" && take.checks.bitIdenticalOutside, splice: take.checks.status } : {}),
          ...(timing ? { lyric_words_heard: `${timing.lyricWordsHeard}/${timing.lyricWords}` } : {}),
        }
      : null,
  };
}

export function mcpTools(studio: Studio): McpTool[] {
  const defs = toolDefinitions(studio.config.maxDurationSec);
  const agentTools = defs.map((d) => wrapAgentTool(d, defs));
  return [
    {
      name: "list_projects",
      description: "List the studio's projects (newest first) with their ids, titles, folders and number of finished takes.",
      inputSchema: { type: "object", additionalProperties: false, properties: {} },
      async run(s) {
        return {
          projects: s.listProjects().map((p) => ({ id: p.id, title: p.title, folder: p.path, finished_takes: p.takeCount, current_take_id: p.currentTakeId })),
        };
      },
    },
    {
      name: "create_project",
      description: "Create a new, empty project (a new folder). Returns its id.",
      inputSchema: { type: "object", additionalProperties: false, properties: { title: { type: "string", description: "Working title." } } },
      async run(s, args) {
        const p = s.createProject(typeof args?.title === "string" ? args.title : undefined);
        return { id: p.id, title: p.title, folder: p.path };
      },
    },
    ...agentTools.map((t) =>
      t.name === "get_project_state"
        ? { ...t, run: async (s: Studio, args: any) => (s.project(String(args?.project_id ?? "")), projectStateForAgent(s, String(args.project_id))) }
        : t,
    ),
    {
      name: "wait_for_job",
      description:
        "Wait until a job started by generate_song or repaint_section has finished (or failed), then return the take it made: its audio file, whether the splice was verified, and how many lyric words speech recognition heard. Waits at most timeout_seconds (default 180); if the job is still running then, call it again.",
      inputSchema: {
        type: "object",
        additionalProperties: false,
        required: ["job_id"],
        properties: { job_id: { type: "string" }, timeout_seconds: { type: "integer", description: "1–600, default 180." } },
      },
      async run(s, args) {
        const id = String(args?.job_id ?? "");
        const timeout = Math.min(600, Math.max(1, Number(args?.timeout_seconds ?? 180))) * 1000;
        const t0 = Date.now();
        for (;;) {
          const job = s.store.getJob(id);
          if (!job) throw new StudioError("not_found", `no job ${id}`);
          const finished = job.status === "done" || job.status === "failed";
          // A finished take is analysed right after; wait for that too so the answer includes what was heard.
          if (finished && !s.queue.isAnalysing(job.takeId)) return jobOut(s, job);
          if (Date.now() - t0 > timeout) return { ...jobOut(s, job), note: "Still running; call wait_for_job again." };
          await new Promise((r) => setTimeout(r, 500));
        }
      },
    },
  ];
}

type JsonRpcId = string | number | null;

function rpcResult(id: JsonRpcId, result: unknown) {
  return { jsonrpc: "2.0", id, result };
}

function rpcError(id: JsonRpcId, code: number, message: string) {
  return { jsonrpc: "2.0", id, error: { code, message } };
}

/** Only pages served from this machine may talk to the endpoint (DNS-rebinding protection). */
export function originAllowed(origin: string | undefined): boolean {
  if (!origin) return true; // not a browser
  try {
    const host = new URL(origin).hostname;
    return host === "localhost" || host === "127.0.0.1" || host === "[::1]" || host === "::1";
  } catch {
    return false;
  }
}

export async function handleMcp(c: Context, studio: Studio, version: string): Promise<Response> {
  if (!originAllowed(c.req.header("origin"))) return c.json(rpcError(null, -32600, "origin not allowed"), 403);
  let msg: any;
  try {
    msg = await c.req.json();
  } catch {
    return c.json(rpcError(null, -32700, "parse error"), 400);
  }
  if (Array.isArray(msg)) return c.json(rpcError(null, -32600, "batches are not supported"), 400);
  if (!msg || msg.jsonrpc !== "2.0" || typeof msg.method !== "string") {
    // A response or something else from the client: nothing to answer.
    return c.body(null, 202);
  }
  const isNotification = msg.id === undefined;
  if (isNotification) return c.body(null, 202);
  const id: JsonRpcId = msg.id;
  const tools = mcpTools(studio);

  switch (msg.method) {
    case "initialize": {
      const asked = String(msg.params?.protocolVersion ?? "");
      return c.json(
        rpcResult(id, {
          protocolVersion: SUPPORTED_VERSIONS.includes(asked) ? asked : DEFAULT_VERSION,
          capabilities: { tools: { listChanged: false } },
          serverInfo: { name: "song-studio", title: "Song Studio", version },
          instructions: INSTRUCTIONS,
        }),
      );
    }
    case "ping":
      return c.json(rpcResult(id, {}));
    case "tools/list":
      return c.json(rpcResult(id, { tools: tools.map(({ name, description, inputSchema }) => ({ name, description, inputSchema })) }));
    case "tools/call": {
      const tool = tools.find((t) => t.name === msg.params?.name);
      if (!tool) return c.json(rpcError(id, -32602, `unknown tool ${msg.params?.name}`));
      try {
        const out = await tool.run(studio, msg.params?.arguments ?? {});
        return c.json(rpcResult(id, { content: [{ type: "text", text: JSON.stringify(out, null, 1) }], structuredContent: out, isError: false }));
      } catch (err) {
        const text = err instanceof StudioError ? err.message : `The tool failed: ${err instanceof Error ? err.message : String(err)}`;
        if (!(err instanceof StudioError)) console.error(`[mcp] ${tool.name} crashed:`, err);
        return c.json(rpcResult(id, { content: [{ type: "text", text }], isError: true }));
      }
    }
    default:
      return c.json(rpcError(id, -32601, `method not found: ${msg.method}`));
  }
}
