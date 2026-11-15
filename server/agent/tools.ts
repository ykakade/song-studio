// The agent's tools: definitions (what the model sees) and execution (thin
// wrappers over the Studio service, which the HTTP API also uses).

import type { LlmToolDef } from "../llm/types.ts";
import { MIN_DURATION_SEC, MIN_REPAINT_SEC, type Studio, StudioError } from "../studio.ts";
import type { Job, Marker, Take, TakeTiming } from "../types.ts";

type Schema = Record<string, any>;

const RANGE_TOLERANCE_SEC = 0.06;

export function toolDefinitions(maxDurationSec: number): LlmToolDef[] {
  return [
    {
      name: "generate_song",
      description:
        "Start generating a brand-new song from scratch. Creates a new take with no parent; use it for the first song in a project or when the person wants to start over, never for changing part of an existing song (use repaint_section for that). " +
        "Returns immediately with a job id and the id of the take being made. The job takes about a minute; you will not see the result in this turn.",
      inputSchema: {
        type: "object",
        additionalProperties: false,
        required: ["title", "style_prompt", "lyrics", "bpm", "key", "duration_seconds"],
        properties: {
          title: { type: "string", description: "Short song title." },
          style_prompt: {
            type: "string",
            description:
              "How the recording should sound: genre, instruments, mood, vocal character, production. Comma-separated description. For a song with lyrics, include a clear upfront lead vocal with crisp diction.",
          },
          lyrics: {
            type: "string",
            description: "The complete lyrics, with section tags such as [verse], [chorus], [bridge], [guitar solo] on their own lines. Use just [instrumental] for a piece without vocals. Keep to about four sung words per bar; lyrics with more words than the duration has room for are rejected.",
          },
          bpm: { type: "integer", description: "Tempo in beats per minute (40–220)." },
          key: { type: "string", description: 'Musical key, written like "C Major" or "A Minor".' },
          duration_seconds: { type: "integer", description: `Length of the song in seconds, ${MIN_DURATION_SEC}–${maxDurationSec}.` },
          time_signature: { type: "string", enum: ["2", "3", "4", "6"], description: "Beats per bar. Defaults to 4." },
          vocal_language: { type: "string", description: 'Language of the lyrics as a two-letter code. Defaults to "en".' },
        },
      },
    },
    {
      name: "repaint_section",
      description:
        "Start regenerating one time range of a finished take, leaving everything outside the range bit-identical. Creates a new take whose parent is take_id. " +
        "The range must come from the person's waveform selection, a saved section marker, a section the app heard in this take, or numbers the person typed; never estimate it. The app rejects a range that does not match its declared source. " +
        "Returns immediately with a job id and the new take's id. The job takes about a minute; you will not see the result in this turn.",
      inputSchema: {
        type: "object",
        additionalProperties: false,
        required: ["take_id", "start_seconds", "end_seconds", "range_source", "lyrics", "change_summary"],
        properties: {
          take_id: { type: "string", description: "The finished take to change, normally the current take." },
          start_seconds: { type: "number", description: "Start of the range to regenerate." },
          end_seconds: { type: "number", description: `End of the range to regenerate. The range must be at least ${MIN_REPAINT_SEC} s long.` },
          range_source: {
            type: "string",
            enum: ["selection", "marker", "detected_section", "user_stated"],
            description:
              'Where the range comes from. "selection": the selection shown in <studio_state>. "marker": a saved section marker (give marker_label). "detected_section": a section the app heard in take_id (give section_label). "user_stated": the person typed these numbers in the conversation.',
          },
          marker_label: { type: "string", description: 'The marker\'s label. Required when range_source is "marker".' },
          section_label: { type: "string", description: 'The heard section\'s label, e.g. "chorus 2". Required when range_source is "detected_section".' },
          lyrics: {
            type: "string",
            description: "The complete lyrics of the whole song as they should read after this change: only the part inside the range altered, every other line unchanged.",
          },
          style_prompt: {
            type: "string",
            description: "Only when the sound of this part should change (for example a guitar solo): the take's style description with the change added. Omit to keep the take's style.",
          },
          change_summary: { type: "string", description: 'One short line for the take history saying what this take changes, e.g. "New chorus lyrics about the sea".' },
        },
      },
    },
    {
      name: "get_project_state",
      description:
        "Read the project: the current take with its full lyrics and parameters, where its sections and lines were heard in the audio, the person's current waveform selection, the section markers, lyrics.md if it was edited by hand, the take history, and jobs in progress. " +
        "Use it when you need lyrics or parameters you do not have for certain. Do not use it to wait for a job.",
      inputSchema: { type: "object", additionalProperties: false, properties: {} },
    },
    {
      name: "set_section_markers",
      description:
        "Save named time ranges of the current song (\"chorus\" 24–36 s) so the person can refer to them by name. Replaces the whole marker list: include every existing marker you want to keep, and leave one out to delete it. " +
        "Only save ranges the person gave you (typed numbers, or their waveform selection); never estimate where a section is.",
      inputSchema: {
        type: "object",
        additionalProperties: false,
        required: ["markers"],
        properties: {
          markers: {
            type: "array",
            description: "The complete new list of markers.",
            items: {
              type: "object",
              additionalProperties: false,
              required: ["label", "start_seconds", "end_seconds"],
              properties: {
                label: { type: "string", description: 'Unique name, e.g. "verse 1", "chorus".' },
                start_seconds: { type: "number" },
                end_seconds: { type: "number" },
              },
            },
          },
        },
      },
    },
    {
      name: "revert_to_take",
      description:
        "Make an earlier finished take the current one. Nothing is deleted or changed; later takes stay in the history. Takes effect immediately (no job).",
      inputSchema: {
        type: "object",
        additionalProperties: false,
        required: ["take_id"],
        properties: { take_id: { type: "string", description: "The take to make current." } },
      },
    },
  ];
}

/**
 * Checks a value against the small JSON Schema subset used above. Needed
 * because tool inputs are streamed eagerly and arrive unvalidated; a truncated
 * or malformed input must be caught here, not inside a tool.
 */
export function validateAgainstSchema(schema: Schema, value: unknown, where = "input"): string | null {
  switch (schema.type) {
    case "object": {
      if (typeof value !== "object" || value === null || Array.isArray(value)) return `${where} must be an object`;
      const obj = value as Record<string, unknown>;
      for (const key of schema.required ?? []) if (obj[key] === undefined || obj[key] === null) return `${where}.${key} is required`;
      for (const [key, v] of Object.entries(obj)) {
        const sub = schema.properties?.[key];
        if (!sub) {
          if (schema.additionalProperties === false) return `${where}.${key} is not a known parameter`;
          continue;
        }
        if (v === undefined || v === null) continue;
        const err = validateAgainstSchema(sub, v, `${where}.${key}`);
        if (err) return err;
      }
      return null;
    }
    case "array": {
      if (!Array.isArray(value)) return `${where} must be a list`;
      for (let i = 0; i < value.length; i++) {
        const err = validateAgainstSchema(schema.items ?? {}, value[i], `${where}[${i}]`);
        if (err) return err;
      }
      return null;
    }
    case "string":
      if (typeof value !== "string") return `${where} must be a string`;
      if (schema.enum && !schema.enum.includes(value)) return `${where} must be one of: ${schema.enum.join(", ")}`;
      return null;
    case "integer":
      if (typeof value !== "number" || !Number.isInteger(value)) return `${where} must be a whole number`;
      return null;
    case "number":
      if (typeof value !== "number" || !Number.isFinite(value)) return `${where} must be a number`;
      return null;
    default:
      return null;
  }
}

// --- what tools return to the model -----------------------------------------------

function takeBrief(t: Take) {
  return {
    id: t.id,
    number: t.seq,
    kind: t.kind,
    status: t.status,
    parent_take_id: t.parentTakeId,
    change_summary: t.changeSummary,
    ...(t.params.repaint ? { repainted_range_seconds: [t.params.repaint.startSec, t.params.repaint.endSec] } : {}),
    ...(t.checks ? { outside_range_identical_to_parent: t.checks.status === "verified" && t.checks.bitIdenticalOutside } : {}),
    ...(t.error ? { error: t.error } : {}),
  };
}

function timingOut(t: TakeTiming | null, analysing: boolean) {
  if (!t) return analysing ? { status: "still listening" } : { status: "not analysed" };
  return {
    status: "analysed",
    lyric_words_heard: t.lyricWordsHeard,
    lyric_words: t.lyricWords,
    sections: t.sections.map((x) => ({ label: x.label, start_seconds: x.startSec, end_seconds: x.endSec, kind: x.kind, words_heard: `${x.wordsHeard}/${x.words}` })),
    lines: t.lines.map((l) => ({ section: l.section, text: l.text, start_seconds: l.startSec, end_seconds: l.endSec, words_heard: `${l.wordsHeard}/${l.words}` })),
  };
}

function markersOut(markers: Marker[]) {
  return markers.map((m) => ({ label: m.label, start_seconds: m.startSec, end_seconds: m.endSec }));
}

export function projectStateForAgent(studio: Studio, projectId: string) {
  const s = studio.snapshot(projectId);
  const cur = s.takes.find((t) => t.id === s.project.currentTakeId) ?? null;
  return {
    project: { id: s.project.id, title: s.project.title },
    current_take: cur
      ? {
          id: cur.id,
          number: cur.seq,
          kind: cur.kind,
          parent_take_id: cur.parentTakeId,
          title: cur.params.title,
          style_prompt: cur.params.stylePrompt,
          lyrics: cur.params.lyrics,
          bpm: cur.params.bpm,
          key: cur.params.key,
          time_signature: cur.params.timeSignature,
          vocal_language: cur.params.vocalLanguage,
          duration_seconds: cur.durationSec,
          heard_in_audio: timingOut(s.timing, s.analysing),
        }
      : null,
    ...(s.lyricsDraft ? { lyrics_md_edited_outside_studio: s.lyricsDraft } : {}),
    project_folder: s.project.path,
    selection: s.project.selection ? { start_seconds: s.project.selection.startSec, end_seconds: s.project.selection.endSec } : null,
    section_markers: markersOut(s.markers),
    takes: s.takes.map((t) => {
      const timing = t.status === "done" ? studio.store.readTiming(t) : null;
      return { ...takeBrief(t), ...(timing ? { lyric_words_heard: `${timing.lyricWordsHeard}/${timing.lyricWords}` } : {}) };
    }),
    jobs_in_progress: s.activeJobs.map((j) => ({ job_id: j.id, take_id: j.takeId, kind: j.kind, status: j.status })),
  };
}

function started(r: { job: Job; take: Take; queuePosition: number }) {
  return {
    started: true,
    job_id: r.job.id,
    take_id: r.take.id,
    take_number: r.take.seq,
    queue_position: r.queuePosition,
    note:
      r.queuePosition > 1
        ? "Queued behind another job. Each job takes about a minute. The app shows progress and loads the take when it is ready."
        : "The job is running. It takes about a minute. The app shows progress and loads the take when it is ready.",
  };
}

export interface ToolOutcome {
  content: string;
  isError: boolean;
}

function near(a: number, b: number): boolean {
  return Math.abs(a - b) <= RANGE_TOLERANCE_SEC;
}

async function run(studio: Studio, projectId: string, name: string, input: any): Promise<unknown> {
  switch (name) {
    case "generate_song":
      return started(
        await studio.startGenerate(projectId, {
          title: input.title,
          stylePrompt: input.style_prompt,
          lyrics: input.lyrics,
          bpm: input.bpm,
          key: input.key,
          durationSec: input.duration_seconds,
          timeSignature: input.time_signature,
          vocalLanguage: input.vocal_language,
        }),
      );

    case "repaint_section": {
      // The guard behind "never guess a time range": the range must match the source it claims.
      let startSec: number = input.start_seconds;
      let endSec: number = input.end_seconds;
      if (input.range_source === "selection") {
        const sel = studio.project(projectId).selection;
        if (!sel) {
          throw new StudioError("invalid", "There is no selection on the waveform. Ask the person to drag across the part they mean, then try again. Do not estimate the range.");
        }
        if (!near(startSec, sel.startSec) || !near(endSec, sel.endSec)) {
          throw new StudioError(
            "invalid",
            `The range ${startSec}–${endSec} s does not match the person's selection, which is ${sel.startSec}–${sel.endSec} s. Use the selection's exact numbers, or ask the person which part they mean.`,
          );
        }
        ({ startSec, endSec } = sel);
      } else if (input.range_source === "marker") {
        const markers = studio.markers(projectId);
        const label = String(input.marker_label ?? "").trim().toLowerCase();
        const marker = markers.find((m) => m.label.toLowerCase() === label);
        if (!marker) {
          const known = markers.map((m) => `"${m.label}"`).join(", ") || "none";
          throw new StudioError("invalid", `There is no section marker called "${input.marker_label ?? ""}". Saved markers: ${known}. Ask the person to select the part on the waveform.`);
        }
        if (!near(startSec, marker.startSec) || !near(endSec, marker.endSec)) {
          throw new StudioError("invalid", `The range ${startSec}–${endSec} s does not match marker "${marker.label}", which is ${marker.startSec}–${marker.endSec} s. Use the marker's exact numbers.`);
        }
        ({ startSec, endSec } = marker);
      } else if (input.range_source === "detected_section") {
        const take = studio.take(projectId, String(input.take_id ?? ""));
        const timing = studio.timing(projectId, take.id);
        if (!timing) {
          throw new StudioError("invalid", `Take ${take.seq} has not been analysed yet, so the app does not know where its sections are. Ask the person to select the part on the waveform.`);
        }
        const label = String(input.section_label ?? "").trim().toLowerCase();
        const sec = timing.sections.find((x) => x.label.toLowerCase() === label);
        if (!sec) {
          const known = timing.sections.map((x) => `"${x.label}"`).join(", ") || "none";
          throw new StudioError("invalid", `No section called "${input.section_label ?? ""}" was heard in take ${take.seq}. Heard sections: ${known}. Ask the person to select the part on the waveform.`);
        }
        if (!near(startSec, sec.startSec) || !near(endSec, sec.endSec)) {
          throw new StudioError("invalid", `The range ${startSec}–${endSec} s does not match the heard section "${sec.label}", which is ${sec.startSec}–${sec.endSec} s. Use its exact numbers.`);
        }
        ({ startSec, endSec } = sec);
      }
      return started(
        await studio.startRepaint(projectId, {
          takeId: input.take_id,
          startSec,
          endSec,
          lyrics: input.lyrics,
          stylePrompt: input.style_prompt,
          changeSummary: input.change_summary,
        }),
      );
    }

    case "get_project_state":
      return projectStateForAgent(studio, projectId);

    case "set_section_markers": {
      const saved = studio.setMarkers(
        projectId,
        (input.markers as any[]).map((m) => ({ label: m.label, startSec: m.start_seconds, endSec: m.end_seconds })),
      );
      return { saved: true, section_markers: markersOut(saved) };
    }

    case "revert_to_take": {
      const take = studio.setCurrentTake(projectId, input.take_id);
      return { reverted: true, current_take: { id: take.id, number: take.seq, title: take.params.title, change_summary: take.changeSummary } };
    }

    default:
      throw new StudioError("invalid", `Unknown tool "${name}".`);
  }
}

/** Validate, run, and turn the outcome (or any error) into text for the model. Never throws. */
export async function executeTool(studio: Studio, projectId: string, defs: LlmToolDef[], name: string, input: unknown): Promise<ToolOutcome> {
  const def = defs.find((d) => d.name === name);
  if (!def) return { content: JSON.stringify({ error: `Unknown tool "${name}".` }), isError: true };
  const problem = validateAgainstSchema(def.inputSchema, input);
  if (problem) {
    return { content: JSON.stringify({ error: `Invalid tool input: ${problem}. Nothing was done.` }), isError: true };
  }
  try {
    return { content: JSON.stringify(await run(studio, projectId, name, input)), isError: false };
  } catch (err) {
    if (err instanceof StudioError) return { content: JSON.stringify({ error: err.message, code: err.code }), isError: true };
    console.error(`[agent] tool ${name} crashed:`, err);
    return { content: JSON.stringify({ error: `The tool failed unexpectedly: ${err instanceof Error ? err.message : String(err)}` }), isError: true };
  }
}
