// Renders a take together with the sounds layered on it into one file: the
// same sum the web client plays live, done once in full precision.

import type { Clip, Track } from "./types.ts";
import type { WavAudio } from "./wav.ts";

/** Clips fade in and out over this long, so a clip that starts or stops mid-note does not click. */
export const CLIP_FADE_SEC = 0.005;

export function dbToGain(db: number): number {
  return 10 ** (db / 20);
}

export interface MixResult {
  audio: WavAudio;
  /** Below 1 when the sum went over full scale and the whole mix was turned down by this factor. */
  scaledBy: number;
  /** Clips that were left out because their file is missing or unreadable. */
  missing: string[];
}

export function renderMix(song: WavAudio, tracks: Track[], clips: Clip[], loadSound: (file: string) => WavAudio | null): MixResult {
  const { sampleRate: sr, channels: ch } = song;
  const frames = song.samples.length / ch;
  const sum = new Float32Array(song.samples.length);
  for (let i = 0; i < sum.length; i++) sum[i] = song.samples[i];

  const cache = new Map<string, WavAudio | null>();
  const missing: string[] = [];
  for (const clip of clips) {
    const track = tracks.find((t) => t.id === clip.trackId);
    if (!track || track.muted) continue;
    if (!cache.has(clip.file)) cache.set(clip.file, loadSound(clip.file));
    const src = cache.get(clip.file);
    if (!src || src.samples.length < src.channels * 2) {
      missing.push(clip.file);
      continue;
    }
    const srcFrames = src.samples.length / src.channels;
    const ratio = src.sampleRate / sr;
    const gain = dbToGain(track.gainDb + clip.gainDb);
    const start = Math.round(clip.startSec * sr);
    const length = Math.min(Math.round(clip.durationSec * sr), frames - start);
    const fade = Math.max(1, Math.min(Math.round(CLIP_FADE_SEC * sr), Math.floor(length / 2)));
    for (let i = 0; i < length; i++) {
      let pos = i * ratio;
      if (clip.loop) pos %= srcFrames;
      else if (pos >= srcFrames) break;
      const a = Math.floor(pos);
      const b = a + 1 < srcFrames ? a + 1 : clip.loop ? 0 : a;
      const f = pos - a;
      const edge = Math.min(1, (i + 1) / fade, (length - i) / fade);
      for (let c = 0; c < ch; c++) {
        const sc = Math.min(c, src.channels - 1);
        const v = src.samples[a * src.channels + sc] * (1 - f) + src.samples[b * src.channels + sc] * f;
        sum[(start + i) * ch + c] += v * gain * edge;
      }
    }
  }

  let peak = 0;
  for (let i = 0; i < sum.length; i++) {
    const a = sum[i] < 0 ? -sum[i] : sum[i];
    if (a > peak) peak = a;
  }
  const scaledBy = peak > 32767 ? 32767 / peak : 1;
  const samples = new Int16Array(sum.length);
  for (let i = 0; i < sum.length; i++) samples[i] = Math.round(sum[i] * scaledBy);
  return { audio: { sampleRate: sr, channels: ch, samples }, scaledBy, missing: [...new Set(missing)] };
}
