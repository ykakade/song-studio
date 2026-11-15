// Minimal WAV reading/writing for 16-bit PCM, which is what ACE-Step produces
// (48 kHz stereo). Anything else is rejected loudly rather than converted.

import { readFile, writeFile } from "node:fs/promises";

export interface WavAudio {
  sampleRate: number;
  channels: number;
  /** Interleaved 16-bit samples: frame i, channel c is at index i * channels + c. */
  samples: Int16Array;
}

export class WavFormatError extends Error {}

export function frameCount(audio: WavAudio): number {
  return audio.samples.length / audio.channels;
}

export function durationSeconds(audio: WavAudio): number {
  return frameCount(audio) / audio.sampleRate;
}

const WAVE_FORMAT_PCM = 1;
const WAVE_FORMAT_EXTENSIBLE = 0xfffe;

export function decodeWav(buf: Buffer): WavAudio {
  if (buf.length < 12 || buf.toString("latin1", 0, 4) !== "RIFF" || buf.toString("latin1", 8, 12) !== "WAVE") {
    throw new WavFormatError("not a RIFF/WAVE file");
  }
  let fmt: { format: number; channels: number; sampleRate: number; bits: number; blockAlign: number } | null = null;
  let dataStart = -1;
  let dataLength = 0;
  let pos = 12;
  while (pos + 8 <= buf.length) {
    const id = buf.toString("latin1", pos, pos + 4);
    const size = buf.readUInt32LE(pos + 4);
    const body = pos + 8;
    if (id === "fmt ") {
      if (size < 16 || body + 16 > buf.length) throw new WavFormatError("truncated fmt chunk");
      let format = buf.readUInt16LE(body);
      if (format === WAVE_FORMAT_EXTENSIBLE && size >= 26) {
        // The real format is the first two bytes of the SubFormat GUID.
        format = buf.readUInt16LE(body + 24);
      }
      fmt = {
        format,
        channels: buf.readUInt16LE(body + 2),
        sampleRate: buf.readUInt32LE(body + 4),
        blockAlign: buf.readUInt16LE(body + 12),
        bits: buf.readUInt16LE(body + 14),
      };
    } else if (id === "data") {
      dataStart = body;
      // Streamed writers sometimes leave 0 or 0xFFFFFFFF here; trust the file length then.
      dataLength = size === 0 || body + size > buf.length ? buf.length - body : size;
      break;
    }
    pos = body + size + (size % 2);
  }
  if (!fmt) throw new WavFormatError("missing fmt chunk");
  if (dataStart < 0) throw new WavFormatError("missing data chunk");
  if (fmt.format !== WAVE_FORMAT_PCM || fmt.bits !== 16) {
    throw new WavFormatError(`only 16-bit PCM is supported (got format ${fmt.format}, ${fmt.bits} bits)`);
  }
  if (fmt.channels < 1 || fmt.sampleRate < 1) throw new WavFormatError("invalid channel count or sample rate");

  const frameBytes = fmt.channels * 2;
  const frames = Math.floor(dataLength / frameBytes);
  const samples = new Int16Array(frames * fmt.channels);
  // Copy rather than alias: the source offset may be odd and the host may be big-endian.
  for (let i = 0, p = dataStart; i < samples.length; i++, p += 2) samples[i] = buf.readInt16LE(p);
  return { sampleRate: fmt.sampleRate, channels: fmt.channels, samples };
}

export function encodeWav(audio: WavAudio): Buffer {
  const dataBytes = audio.samples.length * 2;
  const buf = Buffer.allocUnsafe(44 + dataBytes);
  buf.write("RIFF", 0, "latin1");
  buf.writeUInt32LE(36 + dataBytes, 4);
  buf.write("WAVE", 8, "latin1");
  buf.write("fmt ", 12, "latin1");
  buf.writeUInt32LE(16, 16);
  buf.writeUInt16LE(WAVE_FORMAT_PCM, 20);
  buf.writeUInt16LE(audio.channels, 22);
  buf.writeUInt32LE(audio.sampleRate, 24);
  buf.writeUInt32LE(audio.sampleRate * audio.channels * 2, 28);
  buf.writeUInt16LE(audio.channels * 2, 32);
  buf.writeUInt16LE(16, 34);
  buf.write("data", 36, "latin1");
  buf.writeUInt32LE(dataBytes, 40);
  for (let i = 0, p = 44; i < audio.samples.length; i++, p += 2) buf.writeInt16LE(audio.samples[i], p);
  return buf;
}

export async function readWavFile(path: string): Promise<WavAudio> {
  return decodeWav(await readFile(path));
}

export async function writeWavFile(path: string, audio: WavAudio): Promise<void> {
  await writeFile(path, encodeWav(audio));
}

/**
 * Peak envelope for drawing a waveform without decoding in the browser:
 * `points` values in 0..1, the largest absolute sample (any channel) per bucket.
 */
export function computePeaks(audio: WavAudio, points: number): number[] {
  const frames = frameCount(audio);
  const n = Math.max(1, Math.min(points, frames));
  const peaks = new Array<number>(n).fill(0);
  const ch = audio.channels;
  for (let b = 0; b < n; b++) {
    const from = Math.floor((b * frames) / n) * ch;
    const to = Math.floor(((b + 1) * frames) / n) * ch;
    let max = 0;
    for (let i = from; i < to; i++) {
      const v = audio.samples[i];
      const a = v < 0 ? -v : v;
      if (a > max) max = a;
    }
    peaks[b] = Math.round((max / 32768) * 10000) / 10000;
  }
  return peaks;
}
