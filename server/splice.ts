// The splice: the core guarantee of the product.
//
// ACE-Step's repaint keeps the original waveform outside the repainted range,
// but it then peak-normalises the whole file again. So outside the range its
// output is the parent scaled by one uniform gain (and truncated to 16 bits),
// not the parent itself. We therefore never use the server's file as the take.
// We build the take here:
//
//   outside [start, end)  -> the parent's samples, copied bit for bit
//   inside  [start, end)  -> the server's new audio, with the server's gain undone
//   at each boundary      -> an equal-power crossfade, placed INSIDE the range,
//                            so the bit-exact region runs right up to the boundary
//
// and then we verify the result rather than trusting the construction.

import type { BoundaryCheck, SpliceChecks } from "./types.ts";
import { type WavAudio, frameCount } from "./wav.ts";

export type { BoundaryCheck, SpliceChecks } from "./types.ts";

export interface SpliceOptions {
  startSec: number;
  endSec: number;
  /** Length of each equal-power crossfade. Default 50 ms. */
  crossfadeMs?: number;
  matchLevel?: boolean;
  /** Audio this close to the range is ignored when estimating the gain (the server crossfades ~25 ms there). Default 250 ms. */
  guardMs?: number;
  /** Below this outside-range correlation the server's file is not trusted to line up with the parent. Default 0.999. */
  minCorrelation?: number;
}

export interface SpliceResult {
  audio: WavAudio;
  checks: SpliceChecks;
}

const INT16_MAX = 32767;
const INT16_MIN = -32768;
/** 0.01 dB as a ratio: a clipping limit smaller than this is not reported as one. */
const LIMIT_REPORT_RATIO = 10 ** (-0.01 / 20);

function clip16(v: number): number {
  const r = Math.round(v);
  return r > INT16_MAX ? INT16_MAX : r < INT16_MIN ? INT16_MIN : r;
}

function toDb(ratio: number): number | null {
  return ratio > 0 ? 20 * Math.log10(ratio) : null;
}

function round(v: number | null, digits: number): number | null {
  if (v === null || !Number.isFinite(v)) return null;
  const f = 10 ** digits;
  return Math.round(v * f) / f;
}

/** RMS in dBFS over frames [from, to), all channels. null when the window is empty or silent. */
function rmsDb(samples: Int16Array, channels: number, from: number, to: number): number | null {
  const total = samples.length / channels;
  const a = Math.max(0, from);
  const b = Math.min(total, to);
  if (b <= a) return null;
  let sum = 0;
  for (let i = a * channels; i < b * channels; i++) sum += samples[i] * samples[i];
  const rms = Math.sqrt(sum / ((b - a) * channels)) / 32768;
  return toDb(rms);
}

interface GainEstimate {
  gain: number;
  correlation: number;
  residualLsb: number;
  samples: number;
}

/**
 * Least-squares gain g minimising sum((server - g * parent)^2) over the frames
 * outside [startFrame - guard, endFrame + guard). null when there is too little
 * (or only silent) audio out there.
 */
export function estimateOutsideGain(
  parent: WavAudio,
  server: WavAudio,
  startFrame: number,
  endFrame: number,
  guardFrames: number,
): GainEstimate | null {
  const ch = parent.channels;
  const frames = frameCount(parent);
  const headEnd = Math.max(0, startFrame - guardFrames);
  const tailStart = Math.min(frames, endFrame + guardFrames);
  const p = parent.samples;
  const s = server.samples;
  let spp = 0;
  let sps = 0;
  let sss = 0;
  let n = 0;
  const accumulate = (from: number, to: number) => {
    for (let i = from * ch; i < to * ch; i++) {
      const a = p[i];
      const b = s[i];
      spp += a * a;
      sps += a * b;
      sss += b * b;
    }
    n += Math.max(0, to - from) * ch;
  };
  accumulate(0, headEnd);
  accumulate(tailStart, frames);
  // Need at least a quarter second of non-silent audio to say anything.
  if (n < 0.25 * parent.sampleRate * ch || spp <= 0 || sss <= 0) return null;
  const gain = sps / spp;
  const correlation = sps / Math.sqrt(spp * sss);
  let residual = 0;
  const measure = (from: number, to: number) => {
    for (let i = from * ch; i < to * ch; i++) {
      const d = Math.abs(s[i] - gain * p[i]);
      if (d > residual) residual = d;
    }
  };
  measure(0, headEnd);
  measure(tailStart, frames);
  return { gain, correlation, residualLsb: residual, samples: n };
}

/** Levels either side of a join, and the quietest 5 ms near it, for one file. */
function joinLevels(audio: WavAudio, edge: "start" | "end", frame: number): { keptDb: number | null; newDb: number | null; dipDb: number | null } {
  const sr = audio.sampleRate;
  const ch = audio.channels;
  const frames = frameCount(audio);
  const w = Math.round(0.1 * sr);
  // "kept" is the side outside the repainted range, "new" the side inside it.
  const keptFrom = edge === "start" ? frame - w : frame;
  const newFrom = edge === "start" ? frame : frame - w;
  const keptDb = rmsDb(audio.samples, ch, keptFrom, keptFrom + w);
  const newDb = rmsDb(audio.samples, ch, newFrom, newFrom + w);

  let dipDb: number | null = null;
  if (keptDb !== null && newDb !== null) {
    const short = Math.max(1, Math.round(0.005 * sr));
    const zone = Math.round(0.05 * sr);
    let quietest: number | null = null;
    for (let f = Math.max(0, frame - zone); f + short <= Math.min(frames, frame + zone); f += Math.max(1, short >> 1)) {
      const db = rmsDb(audio.samples, ch, f, f + short) ?? -120;
      if (quietest === null || db < quietest) quietest = db;
    }
    if (quietest !== null) dipDb = quietest - Math.min(keptDb, newDb);
  }
  return { keptDb, newDb, dipDb };
}

function boundaryCheck(out: WavAudio, parent: WavAudio, edge: "start" | "end", frame: number): BoundaryCheck {
  const o = joinLevels(out, edge, frame);
  const p = joinLevels(parent, edge, frame);
  return {
    edge,
    timeSec: round(frame / out.sampleRate, 4)!,
    keptDb: round(o.keptDb, 2),
    newDb: round(o.newDb, 2),
    stepDb: o.keptDb !== null && o.newDb !== null ? round(o.newDb - o.keptDb, 2) : null,
    parentStepDb: p.keptDb !== null && p.newDb !== null ? round(p.newDb - p.keptDb, 2) : null,
    dipDb: round(o.dipDb, 2),
    parentDipDb: round(p.dipDb, 2),
  };
}

function fallback(server: WavAudio, base: Omit<SpliceChecks, "status" | "reason">, reason: string): SpliceResult {
  return {
    audio: { sampleRate: server.sampleRate, channels: server.channels, samples: server.samples.slice() },
    checks: { ...base, status: "fallback", reason, bitIdenticalOutside: false },
  };
}

/** Count samples outside frames [startFrame, endFrame) that differ between two equally shaped files. */
export function compareOutside(
  a: WavAudio,
  b: WavAudio,
  startFrame: number,
  endFrame: number,
): { compared: number; mismatches: number } {
  const ch = a.channels;
  const total = a.samples.length;
  let mismatches = 0;
  if (b.samples.length !== total) return { compared: 0, mismatches: Number.MAX_SAFE_INTEGER };
  for (let i = 0; i < startFrame * ch; i++) if (a.samples[i] !== b.samples[i]) mismatches++;
  for (let i = endFrame * ch; i < total; i++) if (a.samples[i] !== b.samples[i]) mismatches++;
  return { compared: startFrame * ch + (total - endFrame * ch), mismatches };
}

/**
 * Build a repaint take from its parent and the server's repaint output.
 * Never mutates its inputs.
 */
export function spliceRepaint(parent: WavAudio, server: WavAudio, opts: SpliceOptions): SpliceResult {
  const crossfadeMs = opts.crossfadeMs ?? 50;
  const guardMs = opts.guardMs ?? 250;
  const minCorrelation = opts.minCorrelation ?? 0.999;

  const sr = parent.sampleRate;
  const ch = parent.channels;
  const frames = frameCount(parent);
  const startFrame = Math.min(frames, Math.max(0, Math.round(opts.startSec * sr)));
  const endFrame = Math.min(frames, Math.max(startFrame, Math.round(opts.endSec * sr)));

  const base: Omit<SpliceChecks, "status" | "reason"> = {
    startSec: opts.startSec,
    endSec: opts.endSec,
    startFrame,
    endFrame,
    crossfadeMs,
    gain: null,
    gainDb: null,
    correlation: null,
    residualLsb: null,
    appliedGain: 1,
    gainLimitedToAvoidClipping: false,
    outsideSamples: 0,
    outsideMismatches: 0,
    bitIdenticalOutside: false,
    boundaries: [],
  };

  if (server.sampleRate !== sr || server.channels !== ch || frameCount(server) !== frames) {
    return fallback(
      server,
      base,
      `the model's output has a different shape than the parent ` +
        `(${server.sampleRate} Hz, ${server.channels} ch, ${frameCount(server)} frames vs ` +
        `${sr} Hz, ${ch} ch, ${frames} frames)`,
    );
  }
  if (endFrame <= startFrame) {
    return fallback(server, base, "the repaint range is empty");
  }

  // 1. How much did the server turn the untouched audio up or down?
  const est = estimateOutsideGain(parent, server, startFrame, endFrame, Math.round((guardMs / 1000) * sr));
  let inverse = 1;
  if (est) {
    base.gain = round(est.gain, 6);
    base.gainDb = round(toDb(est.gain), 3);
    base.correlation = round(est.correlation, 10);
    base.residualLsb = round(est.residualLsb, 2);
    if (!(est.correlation >= minCorrelation)) {
      return fallback(
        server,
        base,
        `outside the range the model's output does not match the parent ` +
          `(correlation ${est.correlation.toFixed(6)}, expected about 1), so the gain estimate cannot be trusted`,
      );
    }
    if (!(est.gain > 0.25 && est.gain < 4)) {
      return fallback(server, base, `implausible gain estimate (${est.gain.toFixed(4)})`);
    }
    inverse = 1 / est.gain;
  }
  // (No estimate = nothing substantial outside the range to compare against. We
  // still splice, with gain 1; whatever is outside is still copied exactly.)

  // 2. Undoing the gain must not push the new audio past full scale.
  let peak = 0;
  for (let i = startFrame * ch; i < endFrame * ch; i++) {
    const v = server.samples[i];
    const a = v < 0 ? -v : v;
    if (a > peak) peak = a;
  }
  if (peak * inverse > INT16_MAX) {
    const limited = INT16_MAX / peak;
    // The real model often leaves the new section's peak exactly at full scale
    // before it normalises, so undoing the gain lands a fraction of one 16-bit
    // step over the top. That is rounding, not a level change: only report a
    // limit a listener could conceivably notice (more than 0.01 dB).
    base.gainLimitedToAvoidClipping = limited / inverse < LIMIT_REPORT_RATIO;
    inverse = limited;
  }
  base.appliedGain = round(inverse, 6)!;

  // Match the original section's local levels, bounded to +/-6 dB. Interpolate
  // between the two ends; samples outside the selection never enter the output path.
  const window = Math.min(Math.round(sr * 0.15), Math.floor((endFrame - startFrame) / 2));
  const levelRatio = (from: number, to: number) => {
    const oldDb = rmsDb(parent.samples, ch, from, to);
    const newDb = rmsDb(server.samples, ch, from, to);
    if (!opts.matchLevel || oldDb === null || newDb === null || oldDb < -60 || newDb < -60) return 1;
    return 10 ** (Math.max(-6, Math.min(6, oldDb - newDb - 20 * Math.log10(inverse))) / 20);
  };
  const startLevel = levelRatio(startFrame, startFrame + window);
  const endLevel = levelRatio(endFrame - window, endFrame);

  // 3. Assemble: parent everywhere, then overwrite the range.
  const out = parent.samples.slice();
  const fade = Math.min(Math.round((crossfadeMs / 1000) * sr), Math.floor((endFrame - startFrame) / 2));
  const fadeIn = startFrame > 0 ? fade : 0; // nothing to fade from at the very start of the file
  const fadeOut = endFrame < frames ? fade : 0;
  const p = parent.samples;
  const s = server.samples;
  for (let f = startFrame; f < endFrame; f++) {
    let wNew = 1;
    let wOld = 0;
    if (f < startFrame + fadeIn) {
      const t = ((f - startFrame + 0.5) / fadeIn) * (Math.PI / 2);
      wNew = Math.sin(t);
      wOld = Math.cos(t);
    } else if (f >= endFrame - fadeOut) {
      const t = ((f - (endFrame - fadeOut) + 0.5) / fadeOut) * (Math.PI / 2);
      wNew = Math.cos(t);
      wOld = Math.sin(t);
    }
    for (let c = 0; c < ch; c++) {
      const i = f * ch + c;
      const position = (f - startFrame) / Math.max(1, endFrame - startFrame - 1);
      const level = startLevel * (1 - position) + endLevel * position;
      out[i] = clip16(wNew * inverse * level * s[i] + wOld * p[i]);
    }
  }
  const audio: WavAudio = { sampleRate: sr, channels: ch, samples: out };

  // 4. Verify by comparison, not by construction.
  const cmp = compareOutside(audio, parent, startFrame, endFrame);
  const boundaries: BoundaryCheck[] = [];
  if (startFrame > 0) boundaries.push(boundaryCheck(audio, parent, "start", startFrame));
  if (endFrame < frames) boundaries.push(boundaryCheck(audio, parent, "end", endFrame));

  return {
    audio,
    checks: {
      ...base,
      status: cmp.mismatches === 0 ? "verified" : "failed",
      reason:
        cmp.mismatches !== 0
          ? `${cmp.mismatches} samples outside the range differ from the parent`
          : est
            ? null
            : "too little audio outside the range to estimate the model's gain; spliced with gain 1",
      outsideSamples: cmp.compared,
      outsideMismatches: cmp.mismatches,
      bitIdenticalOutside: cmp.mismatches === 0,
      boundaries,
    },
  };
}
