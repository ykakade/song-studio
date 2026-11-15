// Small audio helpers for the timeline: levels, clip waveforms, and turning a
// decoded file into the 16-bit WAV the server stores.

export function dbToGain(db: number): number {
  return 10 ** (db / 20);
}

/** Peak envelope of a decoded sound, `points` values in 0..1 (loudest channel). */
export function peaksOf(buffer: AudioBuffer, points: number): number[] {
  const n = Math.max(1, Math.min(points, buffer.length));
  const out = new Array<number>(n).fill(0);
  for (let c = 0; c < buffer.numberOfChannels; c++) {
    const data = buffer.getChannelData(c);
    for (let b = 0; b < n; b++) {
      const to = Math.floor(((b + 1) * data.length) / n);
      let max = out[b];
      for (let i = Math.floor((b * data.length) / n); i < to; i++) {
        const a = data[i] < 0 ? -data[i] : data[i];
        if (a > max) max = a;
      }
      out[b] = max;
    }
  }
  const top = Math.max(...out, 1e-6);
  return out.map((v) => v / top);
}

/** A decoded sound as a 16-bit PCM WAV file (mono or stereo). */
export function encodeWav16(buffer: AudioBuffer): Blob {
  const channels = Math.min(2, buffer.numberOfChannels);
  const frames = buffer.length;
  const bytes = new ArrayBuffer(44 + frames * channels * 2);
  const v = new DataView(bytes);
  const text = (at: number, s: string) => {
    for (let i = 0; i < s.length; i++) v.setUint8(at + i, s.charCodeAt(i));
  };
  text(0, "RIFF");
  v.setUint32(4, 36 + frames * channels * 2, true);
  text(8, "WAVE");
  text(12, "fmt ");
  v.setUint32(16, 16, true);
  v.setUint16(20, 1, true);
  v.setUint16(22, channels, true);
  v.setUint32(24, buffer.sampleRate, true);
  v.setUint32(28, buffer.sampleRate * channels * 2, true);
  v.setUint16(32, channels * 2, true);
  v.setUint16(34, 16, true);
  text(36, "data");
  v.setUint32(40, frames * channels * 2, true);
  const data = Array.from({ length: channels }, (_, c) => buffer.getChannelData(c));
  let at = 44;
  for (let i = 0; i < frames; i++) {
    for (let c = 0; c < channels; c++) {
      const s = Math.max(-1, Math.min(1, data[c][i]));
      v.setInt16(at, Math.round(s * 32767), true);
      at += 2;
    }
  }
  return new Blob([bytes], { type: "audio/wav" });
}
