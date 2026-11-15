import { fileURLToPath } from "node:url";
import path from "node:path";
import type { WavAudio } from "../server/wav.ts";

export const FIXTURES = path.join(path.dirname(fileURLToPath(import.meta.url)), "fixtures");

/** Small deterministic PRNG so tests never depend on Math.random. */
export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Deterministic "music": a few sines plus noise, stereo, peaking around `level` of full scale. */
export function synth(seconds: number, seed: number, opts: { sampleRate?: number; channels?: number; level?: number } = {}): WavAudio {
  const sampleRate = opts.sampleRate ?? 8000;
  const channels = opts.channels ?? 2;
  const level = opts.level ?? 0.6;
  const rnd = mulberry32(seed);
  const freqs = [110 + rnd() * 200, 300 + rnd() * 500, 900 + rnd() * 900];
  const frames = Math.round(seconds * sampleRate);
  const samples = new Int16Array(frames * channels);
  for (let f = 0; f < frames; f++) {
    const t = f / sampleRate;
    for (let c = 0; c < channels; c++) {
      let v = 0;
      for (let k = 0; k < freqs.length; k++) v += Math.sin(2 * Math.PI * freqs[k] * t + c * 0.7 + k) / freqs.length;
      v = v * 0.7 + (rnd() * 2 - 1) * 0.3;
      samples[f * channels + c] = Math.round(v * level * 32767);
    }
  }
  return { sampleRate, channels, samples };
}

/**
 * What ACE-Step's repaint does to a file, as measured in the spike:
 * keep the source outside the range, put new audio inside, linear crossfade
 * of `xfadeMs` just outside each boundary, then scale the WHOLE file by one
 * gain and truncate to 16 bits.
 */
export function simulateServerRepaint(
  source: WavAudio,
  fresh: WavAudio,
  startSec: number,
  endSec: number,
  gain: number,
  xfadeMs = 25,
): WavAudio {
  const { sampleRate: sr, channels: ch } = source;
  const frames = source.samples.length / ch;
  const s = Math.round(startSec * sr);
  const e = Math.round(endSec * sr);
  const x = Math.round((xfadeMs / 1000) * sr);
  const out = new Int16Array(source.samples.length);
  for (let f = 0; f < frames; f++) {
    let w = 0; // weight of the fresh audio
    if (f >= s && f < e) w = 1;
    else if (f >= s - x && f < s) w = (f - (s - x)) / x;
    else if (f >= e && f < e + x) w = 1 - (f - e) / x;
    for (let c = 0; c < ch; c++) {
      const i = f * ch + c;
      const mixed = (1 - w) * source.samples[i] + w * fresh.samples[i];
      out[i] = Math.max(-32768, Math.min(32767, Math.floor(mixed * gain)));
    }
  }
  return { sampleRate: sr, channels: ch, samples: out };
}

export function dbToGain(db: number): number {
  return 10 ** (db / 20);
}

export function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

export async function waitFor<T>(fn: () => T | undefined | null | false | Promise<T | undefined | null | false>, timeoutMs = 10000, label = "condition"): Promise<T> {
  const t0 = Date.now();
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() - t0 > timeoutMs) throw new Error(`timed out waiting for ${label}`);
    await sleep(25);
  }
}
