import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { computePeaks, decodeWav, durationSeconds, encodeWav, frameCount, WavFormatError } from "../server/wav.ts";
import { FIXTURES, synth } from "./helpers.ts";

test("wav: encode then decode returns the same samples and format", () => {
  const audio = synth(0.5, 1, { sampleRate: 44100, channels: 2 });
  const back = decodeWav(encodeWav(audio));
  assert.equal(back.sampleRate, 44100);
  assert.equal(back.channels, 2);
  assert.deepEqual(back.samples, audio.samples);
});

test("wav: preserves extreme sample values", () => {
  const samples = Int16Array.from([-32768, 32767, 0, -1, 1, 12345]);
  const back = decodeWav(encodeWav({ sampleRate: 8000, channels: 1, samples }));
  assert.deepEqual(back.samples, samples);
});

test("wav: reads a real ACE-Step file (48 kHz stereo 16-bit)", async () => {
  const audio = decodeWav(await readFile(path.join(FIXTURES, "folk_orig_16s.wav")));
  assert.equal(audio.sampleRate, 48000);
  assert.equal(audio.channels, 2);
  assert.equal(frameCount(audio), 16 * 48000);
  assert.equal(durationSeconds(audio), 16);
});

test("wav: re-encoding a real file is byte-identical", async () => {
  const bytes = await readFile(path.join(FIXTURES, "folk_orig_16s.wav"));
  assert.ok(encodeWav(decodeWav(bytes)).equals(bytes));
});

test("wav: skips unknown chunks (with odd-size padding) before the data chunk", () => {
  const audio = synth(0.1, 2, { channels: 1 });
  const plain = encodeWav(audio);
  const extra = Buffer.concat([Buffer.from("LIST"), Buffer.from([3, 0, 0, 0]), Buffer.from("abc"), Buffer.from([0])]);
  const withList = Buffer.concat([plain.subarray(0, 36), extra, plain.subarray(36)]);
  withList.writeUInt32LE(withList.length - 8, 4);
  assert.deepEqual(decodeWav(withList).samples, audio.samples);
});

test("wav: tolerates a data chunk size of 0 (streamed writer)", () => {
  const audio = synth(0.1, 3, { channels: 2 });
  const buf = encodeWav(audio);
  buf.writeUInt32LE(0, 40);
  assert.deepEqual(decodeWav(buf).samples, audio.samples);
});

test("wav: rejects anything that is not 16-bit PCM", () => {
  const buf = encodeWav(synth(0.1, 4));
  const bits24 = Buffer.from(buf);
  bits24.writeUInt16LE(24, 34);
  assert.throws(() => decodeWav(bits24), WavFormatError);
  const float = Buffer.from(buf);
  float.writeUInt16LE(3, 20);
  assert.throws(() => decodeWav(float), WavFormatError);
  assert.throws(() => decodeWav(Buffer.from("not a wav file at all")), WavFormatError);
});

test("wav: peaks are in 0..1 and follow the loud parts", () => {
  const samples = new Int16Array(8000);
  for (let i = 4000; i < 8000; i++) samples[i] = i % 2 ? 16384 : -16384;
  const peaks = computePeaks({ sampleRate: 8000, channels: 1, samples }, 10);
  assert.equal(peaks.length, 10);
  assert.deepEqual(peaks.slice(0, 5), [0, 0, 0, 0, 0]);
  for (const p of peaks.slice(5)) assert.equal(p, 0.5);
});
