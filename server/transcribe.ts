// Runs speech recognition on a take so the app knows where the words are.
// The real transcriber is Whisper (large-v3-turbo on MLX) in a Python child
// process started through uv, so nothing is installed globally; it takes a few
// seconds per take. Tests use a fake one.

import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { APP_ROOT } from "./config.ts";
import type { HeardWord } from "./types.ts";

export interface Transcriber {
  readonly name: string;
  /** `hint` tells a fake transcriber what the take should contain; the real one ignores it. */
  transcribe(wavPath: string, language: string | null, hint?: { lyrics: string; durationSec: number }): Promise<HeardWord[]>;
}

export const WHISPER_MODEL = "mlx-community/whisper-large-v3-turbo";

export class WhisperTranscriber implements Transcriber {
  readonly name = `whisper (${WHISPER_MODEL})`;
  private readonly uv: string;
  private readonly timeoutMs: number;

  constructor(opts: { uv?: string; timeoutMs?: number } = {}) {
    this.uv = opts.uv ?? process.env.UV ?? path.join(os.homedir(), ".local", "bin", "uv");
    this.timeoutMs = opts.timeoutMs ?? 5 * 60_000;
  }

  available(): boolean {
    return existsSync(this.uv);
  }

  transcribe(wavPath: string, language: string | null): Promise<HeardWord[]> {
    const args = [
      "run", "--quiet", "--no-project", "--python", "3.12",
      "--with", "mlx-whisper==0.4.3", "--with", "scipy", "--with", "numpy",
      "python", path.join(APP_ROOT, "scripts", "transcribe.py"), wavPath, language ?? "",
    ];
    return new Promise((resolve, reject) => {
      // The model is cached after the first run; offline keeps it from phoning home every time.
      const child = spawn(this.uv, args, { env: { ...process.env, HF_HUB_OFFLINE: process.env.HF_HUB_OFFLINE ?? "1", TOKENIZERS_PARALLELISM: "false" } });
      let out = "";
      let err = "";
      const timer = setTimeout(() => child.kill("SIGKILL"), this.timeoutMs);
      child.stdout.on("data", (d) => (out += d));
      child.stderr.on("data", (d) => (err = (err + d).slice(-4000)));
      child.on("error", (e) => {
        clearTimeout(timer);
        reject(new Error(`could not start Whisper through uv (${e.message})`));
      });
      child.on("close", (code) => {
        clearTimeout(timer);
        if (code !== 0) {
          const hint = /LocalEntryNotFound|offline/i.test(err)
            ? " The Whisper model is not downloaded yet; run once with HF_HUB_OFFLINE=0."
            : "";
          return reject(new Error(`Whisper exited with code ${code}: ${err.trim().split("\n").slice(-3).join(" | ")}${hint}`));
        }
        try {
          const parsed = JSON.parse(out) as { words: HeardWord[] };
          resolve(parsed.words);
        } catch {
          reject(new Error(`Whisper printed something that is not JSON: ${out.slice(0, 200)}`));
        }
      });
    });
  }
}

/** For tests: "hears" the given lyrics, word by word, spread evenly between two times. */
export class FakeTranscriber implements Transcriber {
  readonly name = "fake transcriber";
  calls: string[] = [];
  private readonly hear: (wavPath: string, hint: { lyrics: string; durationSec: number }) => HeardWord[] | Error;
  constructor(hear: (wavPath: string, hint: { lyrics: string; durationSec: number }) => HeardWord[] | Error) {
    this.hear = hear;
  }
  async transcribe(wavPath: string, _language: string | null, hint = { lyrics: "", durationSec: 0 }): Promise<HeardWord[]> {
    this.calls.push(wavPath);
    const r = this.hear(wavPath, hint);
    if (r instanceof Error) throw r;
    return r;
  }
}

export function evenlySpaced(text: string, fromSec: number, toSec: number): HeardWord[] {
  const ws = text.split(/\s+/).filter(Boolean);
  const step = (toSec - fromSec) / Math.max(1, ws.length);
  return ws.map((w, i) => ({ w, t0: +(fromSec + i * step).toFixed(3), t1: +(fromSec + (i + 0.8) * step).toFixed(3), p: 0.9 }));
}
