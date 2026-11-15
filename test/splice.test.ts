import { test } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { compareOutside, estimateOutsideGain, spliceRepaint } from "../server/splice.ts";
import { readWavFile, type WavAudio } from "../server/wav.ts";
import { dbToGain, FIXTURES, simulateServerRepaint, synth } from "./helpers.ts";

const SR = 8000;

function maxAbsDiff(a: Int16Array, b: Int16Array, from: number, to: number): number {
  let m = 0;
  for (let i = from; i < to; i++) m = Math.max(m, Math.abs(a[i] - b[i]));
  return m;
}

test("splice: outside the range the take is bit-identical to the parent, inside it is the new audio with the gain undone", () => {
  const parent = synth(10, 11);
  const fresh = synth(10, 22);
  const gain = dbToGain(-0.524);
  const server = simulateServerRepaint(parent, fresh, 3, 7, gain);

  // Sanity: the raw server file really is different from the parent outside the range.
  assert.ok(compareOutside(server, parent, 3 * SR, 7 * SR).mismatches > 1000);

  const { audio, checks } = spliceRepaint(parent, server, { startSec: 3, endSec: 7 });
  assert.equal(checks.status, "verified");
  assert.equal(checks.reason, null);
  assert.equal(checks.bitIdenticalOutside, true);
  assert.equal(checks.outsideMismatches, 0);
  assert.equal(checks.outsideSamples, (10 - 4) * SR * 2);
  assert.deepEqual(audio.samples.subarray(0, 3 * SR * 2), parent.samples.subarray(0, 3 * SR * 2));
  assert.deepEqual(audio.samples.subarray(7 * SR * 2), parent.samples.subarray(7 * SR * 2));

  // Gain estimate.
  assert.ok(Math.abs(checks.gainDb! - -0.524) < 0.005, `gainDb ${checks.gainDb}`);
  assert.ok(checks.correlation! > 0.999999);
  assert.ok(checks.residualLsb! <= 1.5, `residual ${checks.residualLsb}`);
  assert.ok(Math.abs(checks.appliedGain - 1 / gain) < 1e-3);
  assert.equal(checks.gainLimitedToAvoidClipping, false);

  // Inside, beyond the 50 ms crossfades, we get the fresh audio at its original level (+-2 LSB of rounding).
  const fade = 0.05 * SR;
  const from = (3 * SR + fade) * 2;
  const to = (7 * SR - fade) * 2;
  assert.ok(maxAbsDiff(audio.samples, fresh.samples, from, to) <= 2);
});

test("splice: crossfades are equal-power, 50 ms, and sit inside the range", () => {
  const parent = synth(6, 5);
  const fresh = synth(6, 6);
  const server = simulateServerRepaint(parent, fresh, 2, 4, 1);
  const { audio, checks } = spliceRepaint(parent, server, { startSec: 2, endSec: 4 });
  assert.equal(checks.crossfadeMs, 50);
  const F = 0.05 * SR; // 400 frames
  const s = 2 * SR;
  const e = 4 * SR;
  const expectAt = (frame: number, wNew: number, wOld: number) => {
    for (let c = 0; c < 2; c++) {
      const i = frame * 2 + c;
      const want = wNew * fresh.samples[i] + wOld * parent.samples[i];
      assert.ok(Math.abs(audio.samples[i] - want) <= 1.5, `frame ${frame}: got ${audio.samples[i]}, want ${want}`);
    }
  };
  // Start: first frame is almost all parent, the middle is 0.707/0.707, the last is almost all new.
  for (const k of [0, F / 2, F - 1]) {
    const t = ((k + 0.5) / F) * (Math.PI / 2);
    expectAt(s + k, Math.sin(t), Math.cos(t));
    assert.ok(Math.abs(Math.sin(t) ** 2 + Math.cos(t) ** 2 - 1) < 1e-12);
  }
  // End: mirrored.
  for (const k of [0, F / 2, F - 1]) {
    const t = ((k + 0.5) / F) * (Math.PI / 2);
    expectAt(e - F + k, Math.cos(t), Math.sin(t));
  }
  // Just past each fade the audio is purely new; just outside the range purely parent.
  expectAt(s + F, 1, 0);
  expectAt(e - F - 1, 1, 0);
  expectAt(s - 1, 0, 1);
  expectAt(e, 0, 1);
});

test("splice: reports the level step and dip at each boundary", () => {
  const parent = synth(8, 1, { level: 0.5 });
  const fresh = synth(8, 2, { level: 0.25 }); // new section is about 6 dB quieter
  const server = simulateServerRepaint(parent, fresh, 2, 6, 1);
  const { checks } = spliceRepaint(parent, server, { startSec: 2, endSec: 6 });
  assert.equal(checks.boundaries.length, 2);
  const [a, b] = checks.boundaries;
  assert.equal(a.edge, "start");
  assert.equal(a.timeSec, 2);
  assert.equal(b.edge, "end");
  assert.equal(b.timeSec, 6);
  for (const x of checks.boundaries) {
    assert.ok(x.stepDb! < -3 && x.stepDb! > -7, `step ${x.stepDb}`);
    assert.ok(Math.abs(x.parentStepDb!) < 1, `parent step ${x.parentStepDb}`);
    assert.ok(x.dipDb! > -6, `dip ${x.dipDb}`);
    assert.ok(x.parentDipDb! > -6 && x.parentDipDb! <= 0.5, `parent dip ${x.parentDipDb}`);
    assert.ok(Math.abs(x.newDb! - x.keptDb! - x.stepDb!) < 0.02);
  }
});

test("splice: a range touching the start or end of the file has no crossfade on that side", () => {
  const parent = synth(6, 7);
  const fresh = synth(6, 8);

  const head = spliceRepaint(parent, simulateServerRepaint(parent, fresh, 0, 2, dbToGain(-0.3)), { startSec: 0, endSec: 2 });
  assert.equal(head.checks.status, "verified");
  assert.equal(head.checks.boundaries.length, 1);
  assert.equal(head.checks.boundaries[0].edge, "end");
  assert.ok(Math.abs(head.audio.samples[0] - fresh.samples[0]) <= 2, "first sample is new audio, not a fade");
  assert.deepEqual(head.audio.samples.subarray(2 * SR * 2), parent.samples.subarray(2 * SR * 2));

  const tail = spliceRepaint(parent, simulateServerRepaint(parent, fresh, 4, 6, dbToGain(-0.3)), { startSec: 4, endSec: 6 });
  assert.equal(tail.checks.status, "verified");
  assert.equal(tail.checks.boundaries.length, 1);
  assert.equal(tail.checks.boundaries[0].edge, "start");
  const last = parent.samples.length - 1;
  assert.ok(Math.abs(tail.audio.samples[last] - fresh.samples[last]) <= 2);
  assert.deepEqual(tail.audio.samples.subarray(0, 4 * SR * 2), parent.samples.subarray(0, 4 * SR * 2));
});

test("splice: very short ranges shrink the crossfade instead of overlapping", () => {
  const parent = synth(4, 9);
  const fresh = synth(4, 10);
  const server = simulateServerRepaint(parent, fresh, 2, 2.06, 1);
  const { audio, checks } = spliceRepaint(parent, server, { startSec: 2, endSec: 2.06 });
  assert.equal(checks.status, "verified");
  assert.equal(checks.bitIdenticalOutside, true);
  // Middle of a 60 ms range with two 30 ms fades: an equal mix at the centre.
  const mid = Math.round(2.03 * SR);
  assert.notEqual(audio.samples[mid * 2], parent.samples[mid * 2]);
});

test("splice: falls back to the server's file when the outside audio does not match the parent", () => {
  const parent = synth(8, 31);
  const unrelated = synth(8, 32); // the "server" returned a different song altogether
  const { audio, checks } = spliceRepaint(parent, unrelated, { startSec: 3, endSec: 5 });
  assert.equal(checks.status, "fallback");
  assert.equal(checks.bitIdenticalOutside, false);
  assert.match(checks.reason!, /correlation/);
  assert.ok(checks.correlation! < 0.5);
  assert.deepEqual(audio.samples, unrelated.samples);
});

test("splice: falls back when the server's output is time-shifted by a few samples", () => {
  const parent = synth(8, 33);
  const fresh = synth(8, 34);
  const server = simulateServerRepaint(parent, fresh, 3, 5, 1);
  const shifted = { ...server, samples: new Int16Array(server.samples.length) };
  shifted.samples.set(server.samples.subarray(0, server.samples.length - 6), 6); // 3 frames late
  const { checks } = spliceRepaint(parent, shifted, { startSec: 3, endSec: 5 });
  assert.equal(checks.status, "fallback");
});

test("splice: falls back when length, sample rate or channel count differ", () => {
  const parent = synth(4, 41);
  const longer = synth(5, 41);
  const r1 = spliceRepaint(parent, longer, { startSec: 1, endSec: 2 });
  assert.equal(r1.checks.status, "fallback");
  assert.match(r1.checks.reason!, /different shape/);
  assert.deepEqual(r1.audio.samples, longer.samples);

  const mono = synth(4, 41, { channels: 1 });
  assert.equal(spliceRepaint(parent, mono, { startSec: 1, endSec: 2 }).checks.status, "fallback");
  const otherRate = { ...parent, sampleRate: 16000 };
  assert.equal(spliceRepaint(parent, otherRate, { startSec: 1, endSec: 2 }).checks.status, "fallback");
});

test("splice: falls back on an implausible gain", () => {
  const parent = synth(6, 51, { level: 0.5 });
  const fresh = synth(6, 52, { level: 0.05 });
  const server = simulateServerRepaint(parent, fresh, 2, 4, 0.1); // -20 dB: not something normalisation would do
  const { checks } = spliceRepaint(parent, server, { startSec: 2, endSec: 4 });
  assert.equal(checks.status, "fallback");
  assert.match(checks.reason!, /implausible gain/);
});

test("splice: limits the inverse gain rather than clipping the new audio", () => {
  // The model's new section was so loud that normalising turned the whole file down by 6 dB:
  // outside is parent * 0.5, inside is already near full scale. Undoing the 6 dB would clip it.
  const parent = synth(6, 61, { level: 0.6 });
  const fresh = synth(6, 62, { level: 0.98 });
  const gain = 0.5;
  const server: WavAudio = { ...parent, samples: Int16Array.from(parent.samples, (v) => Math.floor(v * gain)) };
  server.samples.set(fresh.samples.subarray(2 * SR * 2, 4 * SR * 2), 2 * SR * 2);
  const { audio, checks } = spliceRepaint(parent, server, { startSec: 2, endSec: 4 });
  assert.equal(checks.status, "verified");
  assert.equal(checks.gainLimitedToAvoidClipping, true);
  assert.ok(checks.appliedGain < 1 / gain);
  let peak = 0;
  let flat = 0;
  for (let i = 2 * SR * 2; i < 4 * SR * 2; i++) {
    const a = Math.abs(audio.samples[i]);
    peak = Math.max(peak, a);
    if (a >= 32767) flat++;
  }
  assert.ok(peak <= 32767);
  assert.ok(flat <= 4, `${flat} samples at full scale: looks like clipping`);
});

test("splice: a new section that peaks at full scale is not reported as limited (seen with the real model)", () => {
  // The real model normalised to -1 dBFS with the new section holding the peak (gain exactly -1.000 dB).
  // Undoing that lands within one 16-bit step of full scale; that must not read as "gain limited".
  const gain = 10 ** (-1 / 20);
  const parent = synth(6, 63, { level: 0.6 });
  const fresh = synth(6, 64, { level: 0.5 });
  const server: WavAudio = { ...parent, samples: Int16Array.from(parent.samples, (v) => Math.floor(v * gain)) };
  server.samples.set(fresh.samples.subarray(2 * SR * 2, 4 * SR * 2), 2 * SR * 2);
  server.samples[3 * SR * 2] = Math.ceil(32767 * gain) + 1; // the peak: a hair over full scale once the gain is undone
  const { audio, checks } = spliceRepaint(parent, server, { startSec: 2, endSec: 4 });
  assert.equal(checks.status, "verified");
  assert.equal(checks.gainLimitedToAvoidClipping, false);
  assert.ok(Math.abs(checks.appliedGain * gain - 1) < 1e-3);
  assert.equal(audio.samples[3 * SR * 2], 32767);
});

test("splice: when the range covers the whole file there is nothing to compare, and it says so", () => {
  const parent = synth(3, 71);
  const fresh = synth(3, 72);
  const { audio, checks } = spliceRepaint(parent, fresh, { startSec: 0, endSec: 3 });
  assert.equal(checks.status, "verified");
  assert.equal(checks.gain, null);
  assert.equal(checks.outsideSamples, 0);
  assert.match(checks.reason!, /too little audio outside/);
  assert.deepEqual(audio.samples, fresh.samples);
});

test("splice: silence outside the range still splices (gain cannot be estimated)", () => {
  const parent = synth(6, 81);
  parent.samples.fill(0, 0, 2 * SR * 2);
  parent.samples.fill(0, 4 * SR * 2);
  const fresh = synth(6, 82);
  const server = simulateServerRepaint(parent, fresh, 2, 4, 1);
  const { checks } = spliceRepaint(parent, server, { startSec: 2, endSec: 4 });
  assert.equal(checks.status, "verified");
  assert.equal(checks.gain, null);
  assert.equal(checks.bitIdenticalOutside, true);
});

test("splice: out-of-bounds ranges are clamped to the file", () => {
  const parent = synth(4, 91);
  const fresh = synth(4, 92);
  const server = simulateServerRepaint(parent, fresh, 3, 4, 1);
  const { checks } = spliceRepaint(parent, server, { startSec: 3, endSec: 99 });
  assert.equal(checks.status, "verified");
  assert.equal(checks.endFrame, 4 * SR);
});

test("splice: inputs are never modified", () => {
  const parent = synth(4, 101);
  const fresh = synth(4, 102);
  const server = simulateServerRepaint(parent, fresh, 1, 3, dbToGain(-0.4));
  const p0 = parent.samples.slice();
  const s0 = server.samples.slice();
  const { audio } = spliceRepaint(parent, server, { startSec: 1, endSec: 3 });
  assert.deepEqual(parent.samples, p0);
  assert.deepEqual(server.samples, s0);
  assert.notEqual(audio.samples.buffer, parent.samples.buffer);
});

test("splice: gain estimator is exact for an exactly scaled copy", () => {
  const parent = synth(4, 111);
  const scaled: WavAudio = { ...parent, samples: Int16Array.from(parent.samples, (v) => Math.round(v * 0.5)) };
  const est = estimateOutsideGain(parent, scaled, 1 * SR, 2 * SR, 0)!;
  assert.ok(Math.abs(est.gain - 0.5) < 1e-4);
  assert.ok(est.correlation > 0.99999);
  assert.ok(est.residualLsb <= 0.51);
});

test("splice (chained): a repaint of a repaint of a repaint does not drift outside the ranges", () => {
  const take1 = synth(20, 201);
  const ranges: Array<[number, number, number]> = [
    [4, 8, -0.524], // [start, end, server gain in dB]
    [12, 15, -0.219],
    [6.5, 9.5, -0.35], // overlaps the first range
    [16, 17, 0],
    [1, 2, -0.5],
  ];

  let ours: WavAudio = take1; // chain of app takes (spliced)
  let naive: WavAudio = take1; // chain that uses the server's files directly
  ranges.forEach(([start, end, db], k) => {
    const fresh = synth(20, 300 + k);
    const result = spliceRepaint(ours, simulateServerRepaint(ours, fresh, start, end, dbToGain(db)), { startSec: start, endSec: end });
    assert.equal(result.checks.status, "verified", `step ${k}`);
    assert.equal(result.checks.bitIdenticalOutside, true, `step ${k}`);
    assert.ok(Math.abs(result.checks.gainDb! - db) < 0.01, `step ${k}: gainDb ${result.checks.gainDb}`);
    // Every take equals its own parent outside its own range...
    assert.equal(compareOutside(result.audio, ours, start * SR, end * SR).mismatches, 0);
    ours = result.audio;
    naive = simulateServerRepaint(naive, fresh, start, end, dbToGain(db));
  });

  // ...and therefore the last take equals the FIRST take everywhere no range ever touched.
  const touched = (t: number) => ranges.some(([s, e]) => t >= s && t < e);
  let compared = 0;
  let differs = 0;
  let naiveDiffers = 0;
  let naiveMax = 0;
  for (let f = 0; f < 20 * SR; f++) {
    if (touched(f / SR)) continue;
    for (let c = 0; c < 2; c++) {
      const i = f * 2 + c;
      compared++;
      if (ours.samples[i] !== take1.samples[i]) differs++;
      if (naive.samples[i] !== take1.samples[i]) {
        naiveDiffers++;
        naiveMax = Math.max(naiveMax, Math.abs(naive.samples[i] - take1.samples[i]));
      }
    }
  }
  assert.ok(compared > 8 * SR * 2);
  assert.equal(differs, 0, "spliced chain drifted outside the ranges");
  // The same chain without the splice drifts a lot (about -1.6 dB in total), which is what this module prevents.
  assert.ok(naiveDiffers > compared * 0.9, `naive chain only differs in ${naiveDiffers}/${compared}`);
  assert.ok(naiveMax > 1000, `naive max diff ${naiveMax}`);
});

test("splice (chained): 25 repaints of the same range leave the rest untouched", () => {
  const take1 = synth(6, 401);
  let ours = take1;
  for (let k = 0; k < 25; k++) {
    const fresh = synth(6, 500 + k);
    const r = spliceRepaint(ours, simulateServerRepaint(ours, fresh, 2, 4, dbToGain(-0.5)), { startSec: 2, endSec: 4 });
    assert.equal(r.checks.status, "verified");
    ours = r.audio;
  }
  assert.equal(compareOutside(ours, take1, 2 * SR, 4 * SR).mismatches, 0);
});

test("splice (real model pair): the folk repaint from the spike", async () => {
  const parent = await readWavFile(path.join(FIXTURES, "folk_orig_16s.wav"));
  const server = await readWavFile(path.join(FIXTURES, "folk_repaint_16s.wav"));
  // The spike repainted 23.0-36.0 s; the clips start at 21.5 s.
  const { audio, checks } = spliceRepaint(parent, server, { startSec: 1.5, endSec: 14.5 });
  assert.equal(checks.status, "verified");
  assert.equal(checks.bitIdenticalOutside, true);
  assert.equal(checks.outsideSamples, 3 * 48000 * 2);
  assert.ok(Math.abs(checks.gainDb! - -0.524) < 0.01, `gainDb ${checks.gainDb}`);
  assert.ok(checks.correlation! > 0.99999999, `correlation ${checks.correlation}`);
  assert.ok(checks.residualLsb! <= 1.5, `residual ${checks.residualLsb}`);
  assert.equal(checks.boundaries.length, 2);
  // The raw server file differs from the parent in most outside samples; the take in none.
  const raw = compareOutside(server, parent, 1.5 * 48000, 14.5 * 48000);
  assert.ok(raw.mismatches > raw.compared * 0.9);
  assert.equal(compareOutside(audio, parent, 1.5 * 48000, 14.5 * 48000).mismatches, 0);
  // Inside (past the fades) it is the model's new audio with the gain undone.
  const g = 1 / checks.gain!;
  for (const t of [3, 8, 13]) {
    const i = Math.round(t * 48000) * 2;
    assert.ok(Math.abs(audio.samples[i] - server.samples[i] * g) <= 1);
  }
});
