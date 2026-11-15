// Finds the beat in a take's audio, so that layered sounds can be rendered at
// the song's real tempo and snapped onto its beats.
//
// The model is asked for a tempo but reports nothing about what it played, so
// this measures it: an onset envelope (how much louder each 10 ms is than the
// one before, in a low and a high band), then a search for the tempo close to
// the requested one and the phase whose beats land on the most onsets.

import type { BeatGrid } from "./types.ts";
import type { WavAudio } from "./wav.ts";

const HOP_SEC = 0.01;
/** How far the real tempo may be from the requested one. */
const TEMPO_WINDOW = 0.04;
/** Beats must collect this many times the average onset strength to count as found. */
const MIN_CONTRAST = 1.6;

/** Onset strength per 10 ms hop: [low band, everything above it]. */
function onsetEnvelopes(audio: WavAudio): { low: Float32Array; high: Float32Array } {
  const { sampleRate: sr, channels: ch, samples } = audio;
  const frames = samples.length / ch;
  const hop = Math.max(1, Math.round(sr * HOP_SEC));
  const n = Math.floor(frames / hop);
  const lowE = new Float32Array(n);
  const highE = new Float32Array(n);
  // One-pole low-pass at about 150 Hz splits the kick and bass from the rest.
  const a = 1 - Math.exp((-2 * Math.PI * 150) / sr);
  let lp = 0;
  for (let h = 0; h < n; h++) {
    let lo = 0;
    let hi = 0;
    for (let f = h * hop, end = f + hop; f < end; f++) {
      let x = 0;
      for (let c = 0; c < ch; c++) x += samples[f * ch + c];
      x /= ch * 32768;
      lp += a * (x - lp);
      lo += lp * lp;
      const r = x - lp;
      hi += r * r;
    }
    lowE[h] = Math.sqrt(lo / hop);
    highE[h] = Math.sqrt(hi / hop);
  }
  const rise = (e: Float32Array) => {
    const out = new Float32Array(n);
    let sum = 0;
    for (let i = 1; i < n; i++) {
      const d = e[i] - e[i - 1];
      if (d > 0) {
        out[i] = d;
        sum += d;
      }
    }
    const mean = sum / Math.max(1, n);
    if (mean > 0) for (let i = 0; i < n; i++) out[i] /= mean;
    return out;
  };
  return { low: rise(lowE), high: rise(highE) };
}

function nominal(bpm: number, beatsPerBar: number): BeatGrid {
  return { bpm, beatSec: 60 / bpm, firstBeatSec: 0, beatsPerBar, detected: false };
}

export function estimateBeatGrid(audio: WavAudio, nominalBpm: number, beatsPerBar = 4): BeatGrid {
  const { low, high } = onsetEnvelopes(audio);
  const n = low.length;
  if (n < 300 || !(nominalBpm > 0)) return nominal(nominalBpm, beatsPerBar);

  // Combined envelope, widened by one hop either side so a beat a few ms off its slot still counts.
  const env = new Float32Array(n);
  for (let i = 0; i < n; i++) env[i] = low[i] + high[i];
  const wide = new Float32Array(n);
  for (let i = 0; i < n; i++) wide[i] = Math.max(env[i], 0.6 * (env[i - 1] ?? 0), 0.6 * (env[i + 1] ?? 0));
  const at = (e: Float32Array, pos: number) => {
    const i = Math.floor(pos);
    if (i < 0 || i + 1 >= n) return 0;
    const f = pos - i;
    return e[i] * (1 - f) + e[i + 1] * f;
  };

  let best = { score: -1, period: 0, phase: 0 };
  const lo = nominalBpm * (1 - TEMPO_WINDOW);
  const hi = nominalBpm * (1 + TEMPO_WINDOW);
  const step = Math.max(0.005, nominalBpm / 5000);
  for (let bpm = lo; bpm <= hi; bpm += step) {
    const period = 60 / bpm / HOP_SEC;
    // Half-hop steps for the phase.
    for (let phase = 0; phase < period; phase += 0.5) {
      let sum = 0;
      let count = 0;
      for (let p = phase; p < n - 1; p += period) {
        sum += at(wide, p);
        count++;
      }
      // A tiny pull towards the requested tempo breaks ties between near-equal candidates.
      const score = (sum / Math.max(1, count)) * (1 - 0.02 * Math.abs(bpm - nominalBpm) / nominalBpm);
      if (score > best.score) best = { score, period, phase };
    }
  }

  let total = 0;
  for (let i = 0; i < n; i++) total += wide[i];
  const contrast = best.score / Math.max(1e-9, total / n);
  if (!(contrast >= MIN_CONTRAST)) return nominal(nominalBpm, beatsPerBar);

  // Which of the beats is the "one": the one where the low band (kick, bass) hits hardest.
  let downbeat = 0;
  let downScore = -1;
  for (let k = 0; k < beatsPerBar; k++) {
    let sum = 0;
    let count = 0;
    for (let p = best.phase + k * best.period; p < n - 1; p += best.period * beatsPerBar) {
      sum += at(low, p) + at(low, p + 1);
      count++;
    }
    const s = sum / Math.max(1, count);
    if (s > downScore * 1.15) {
      downScore = s;
      downbeat = k;
    }
  }
  const beatSec = best.period * HOP_SEC;
  const firstBeatSec = (best.phase + downbeat * best.period) * HOP_SEC;
  const round = (v: number, d: number) => Math.round(v * 10 ** d) / 10 ** d;
  return { bpm: round(60 / beatSec, 2), beatSec: round(beatSec, 5), firstBeatSec: round(firstBeatSec, 3), beatsPerBar, detected: true };
}

/** The beat nearest to a time (bars are not special here). */
export function snapToBeat(grid: BeatGrid, sec: number): number {
  const k = Math.round((sec - grid.firstBeatSec) / grid.beatSec);
  return Math.max(0, Math.round((grid.firstBeatSec + k * grid.beatSec) * 1000) / 1000);
}
