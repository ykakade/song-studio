import { existsSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const APP_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

export interface Config {
  host: string;
  port: number;
  dataDir: string;
  /** Where project folders live. null = <dataDir>/projects. */
  projectsDir: string | null;
  acestepUrl: string;
  /** How often the job worker polls ACE-Step's /query_result. */
  pollIntervalMs: number;
  /** A job that has not finished after this long is failed. */
  jobTimeoutMs: number;
  llm: "anthropic" | "fake";
  anthropicApiKey: string | null;
  anthropicBaseUrl: string | null;
  model: string;
  effort: string | null;
  refusalFallback: boolean;
  /** Longest song the generate tool accepts, in seconds. */
  maxDurationSec: number;
  keepRawRepaint: boolean;
  /** New songs use ACE-Step's LM planner (`thinking`). Slower, usually better. */
  lmPlanner: boolean;
  /** Find where the lyrics are in each take with Whisper. */
  timing: boolean;
}

export const DEFAULT_MODEL = "claude-sonnet-5-5";

/** Models whose refusals the API can retry server-side with `fallbacks: "default"`. */
const FALLBACK_MODELS = new Set(["claude-sonnet-5-5", "claude-opus-5-5", "claude-opus-5", "claude-fable-5-1", "claude-fable-5"]);

/** Reads `.env` from the app root into process.env (existing variables win). */
export function loadDotEnv(): void {
  const file = path.join(APP_ROOT, ".env");
  if (existsSync(file)) process.loadEnvFile(file);
}

function expandHome(p: string): string {
  return p === "~" || p.startsWith("~/") ? path.join(os.homedir(), p.slice(1)) : p;
}

/** The folder that holds the project folders. */
export function projectsDirOf(config: Pick<Config, "dataDir" | "projectsDir">): string {
  return config.projectsDir ?? path.join(config.dataDir, "projects");
}

function nonEmpty(v: string | undefined): string | null {
  const t = v?.trim();
  return t ? t : null;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const llm = (nonEmpty(env.SONG_STUDIO_LLM) ?? "anthropic").toLowerCase();
  if (llm !== "anthropic" && llm !== "fake") {
    throw new Error(`SONG_STUDIO_LLM must be "anthropic" or "fake" (got "${llm}")`);
  }
  const model = nonEmpty(env.SONG_STUDIO_MODEL) ?? DEFAULT_MODEL;
  const baseUrl = nonEmpty(env.ANTHROPIC_BASE_URL);
  const effort = (nonEmpty(env.SONG_STUDIO_EFFORT) ?? "medium").toLowerCase();
  const fallbackSetting = (nonEmpty(env.SONG_STUDIO_REFUSAL_FALLBACK) ?? "auto").toLowerCase();
  return {
    host: nonEmpty(env.HOST) ?? "127.0.0.1",
    port: Number(nonEmpty(env.PORT) ?? 8787),
    dataDir: path.resolve(APP_ROOT, nonEmpty(env.SONG_STUDIO_DATA_DIR) ?? "data"),
    projectsDir: nonEmpty(env.SONG_STUDIO_PROJECTS_DIR) ? path.resolve(APP_ROOT, expandHome(env.SONG_STUDIO_PROJECTS_DIR!.trim())) : null,
    acestepUrl: (nonEmpty(env.ACESTEP_URL) ?? "http://127.0.0.1:8001").replace(/\/+$/, ""),
    pollIntervalMs: Number(nonEmpty(env.SONG_STUDIO_POLL_MS) ?? 1500),
    jobTimeoutMs: Number(nonEmpty(env.SONG_STUDIO_JOB_TIMEOUT_MS) ?? 15 * 60 * 1000),
    llm,
    anthropicApiKey: nonEmpty(env.ANTHROPIC_API_KEY),
    anthropicBaseUrl: baseUrl,
    model,
    effort: effort === "none" ? null : effort,
    // Server-side refusal fallback is a first-party API beta: on by default there,
    // off behind a custom base URL (a gateway may reject the field) or when disabled.
    refusalFallback:
      fallbackSetting === "off" || fallbackSetting === "false" || fallbackSetting === "0"
        ? false
        : fallbackSetting === "on" || (!baseUrl && FALLBACK_MODELS.has(model)),
    maxDurationSec: 120,
    keepRawRepaint: nonEmpty(env.SONG_STUDIO_KEEP_RAW) === "1",
    lmPlanner: !["off", "false", "0"].includes((nonEmpty(env.SONG_STUDIO_LM_PLANNER) ?? "on").toLowerCase()),
    timing: !["off", "false", "0"].includes((nonEmpty(env.SONG_STUDIO_TIMING) ?? "on").toLowerCase()),
  };
}
