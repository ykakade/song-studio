// The built-in sound library: drum, bass, guitar and keyboard parts that can be
// layered on top of a song. Nothing here is a recording. Every sound is
// synthesised on the spot at the song's tempo and in its key, so the library
// costs no disk space and a loop always fits the bar it is dropped on.
//
// Loops are rendered "wrapped": a note that rings past the end of the loop
// continues at its start, so the file repeats without a gap or a click.
//
// Pitched sounds only know the song's key, not its chords, so they stay on the
// home chord of the key (G major in G Major). That sits well under most of a
// song and can rub against it where the harmony moves away.

import type { Instrument, SoundInfo } from "./types.ts";
import type { WavAudio } from "./wav.ts";

export interface RenderOptions {
  bpm: number;
  /** "G Major", "A Minor", "F# minor"... Unreadable keys fall back to C major. */
  key: string;
  beatsPerBar: number;
  sampleRate: number;
}

const LOOP_BARS = 2;

/** Small deterministic PRNG: the same sound always renders to the same bytes. */
function prng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// --- key ------------------------------------------------------------------------------

const PITCH_CLASS: Record<string, number> = { c: 0, d: 2, e: 4, f: 5, g: 7, a: 9, b: 11 };

export function parseKey(key: string): { pitchClass: number; minor: boolean } {
  const m = /^\s*([A-Ga-g])\s*([#♯b♭]?)\s*(.*)$/.exec(key ?? "");
  if (!m) return { pitchClass: 0, minor: false };
  let pc = PITCH_CLASS[m[1].toLowerCase()];
  if (m[2] === "#" || m[2] === "♯") pc += 1;
  if (m[2] === "b" || m[2] === "♭") pc -= 1;
  const rest = m[3].trim();
  const minor = /^(m|min|minor)\b/i.test(rest) && !/^maj/i.test(rest);
  return { pitchClass: (pc + 12) % 12, minor };
}

const hz = (midi: number) => 440 * 2 ** ((midi - 69) / 12);

/** The lowest note with this pitch class at or above `floor` (a MIDI note). */
function rootAbove(pitchClass: number, floor: number): number {
  return floor + ((pitchClass - (floor % 12) + 12) % 12);
}

// --- voices: each returns one mono note -------------------------------------------------

type Voice = Float32Array;

function kick(sr: number): Voice {
  const n = Math.round(sr * 0.4);
  const out = new Float32Array(n);
  let phase = 0;
  for (let i = 0; i < n; i++) {
    const t = i / sr;
    phase += (2 * Math.PI * (46 + 115 * Math.exp(-t / 0.028))) / sr;
    out[i] = Math.sin(phase) * Math.exp(-t / 0.13) * Math.min(1, t / 0.001);
  }
  return out;
}

/** White noise with the lows taken out (`cut` near 1 removes more). */
function hiss(n: number, rnd: () => number, cut: number): Float32Array {
  const out = new Float32Array(n);
  let lp = 0;
  for (let i = 0; i < n; i++) {
    const x = rnd() * 2 - 1;
    lp += cut * (x - lp);
    out[i] = x - lp;
  }
  return out;
}

function snare(sr: number, rnd: () => number): Voice {
  const n = Math.round(sr * 0.28);
  const noise = hiss(n, rnd, 0.25);
  const out = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const t = i / sr;
    const body = Math.sin(2 * Math.PI * 188 * t) * Math.exp(-t / 0.045) + 0.5 * Math.sin(2 * Math.PI * 331 * t) * Math.exp(-t / 0.03);
    out[i] = 0.75 * noise[i] * Math.exp(-t / 0.07) + 0.55 * body;
  }
  return out;
}

function hat(sr: number, rnd: () => number, open: boolean): Voice {
  const n = Math.round(sr * (open ? 0.32 : 0.07));
  const noise = hiss(n, rnd, 0.82);
  const out = new Float32Array(n);
  const decay = open ? 0.09 : 0.014;
  // A second differentiation leaves only the top of the spectrum, which is what reads as metal.
  for (let i = 1; i < n; i++) out[i] = (noise[i] - 0.9 * noise[i - 1]) * Math.exp(-(i / sr) / decay);
  return out;
}

function clap(sr: number, rnd: () => number): Voice {
  const n = Math.round(sr * 0.3);
  const noise = hiss(n, rnd, 0.35);
  const out = new Float32Array(n);
  let lp = 0;
  for (let i = 0; i < n; i++) {
    const t = i / sr;
    let env = 0;
    for (const start of [0, 0.011, 0.023]) if (t >= start) env = Math.max(env, Math.exp(-(t - start) / 0.005));
    if (t >= 0.03) env = Math.max(env, 0.8 * Math.exp(-(t - 0.03) / 0.07));
    lp += 0.45 * (noise[i] * env - lp);
    out[i] = lp;
  }
  return out;
}

function shake(sr: number, rnd: () => number): Voice {
  const n = Math.round(sr * 0.09);
  const noise = hiss(n, rnd, 0.7);
  const out = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const t = i / sr;
    out[i] = noise[i] * Math.min(1, t / 0.012) * Math.exp(-Math.max(0, t - 0.012) / 0.022);
  }
  return out;
}

function crash(sr: number, rnd: () => number): Voice {
  const n = Math.round(sr * 3);
  const noise = hiss(n, rnd, 0.6);
  const out = new Float32Array(n);
  for (let i = 1; i < n; i++) {
    const t = i / sr;
    out[i] = (noise[i] - 0.5 * noise[i - 1]) * (0.7 * Math.exp(-t / 0.25) + 0.3 * Math.exp(-t / 0.9)) * Math.min(1, t / 0.002);
  }
  return out;
}

/** A plucked string (Karplus–Strong): a burst of noise circulating in a delay line that slowly loses its highs. */
function pluck(sr: number, freq: number, seconds: number, rnd: () => number, bright = 0.5): Voice {
  const period = Math.max(2, Math.round(sr / freq));
  const line = new Float32Array(period);
  let lp = 0;
  for (let i = 0; i < period; i++) {
    lp += (0.25 + 0.7 * bright) * (rnd() * 2 - 1 - lp);
    line[i] = lp;
  }
  const n = Math.round(sr * seconds);
  const out = new Float32Array(n);
  // Higher strings die away sooner, as on a real guitar.
  const loss = 0.9985 - Math.min(0.004, freq / 200000);
  let at = 0;
  for (let i = 0; i < n; i++) {
    const next = at + 1 === period ? 0 : at + 1;
    out[i] = line[at];
    line[at] = loss * 0.5 * (line[at] + line[next]);
    at = next;
  }
  // Fade the last 30 ms so a cut-off note does not click.
  const fade = Math.min(n, Math.round(sr * 0.03));
  for (let i = 0; i < fade; i++) out[n - 1 - i] *= i / fade;
  return out;
}

function bassNote(sr: number, freq: number, seconds: number): Voice {
  const n = Math.round(sr * seconds);
  const out = new Float32Array(n);
  const release = 0.04;
  for (let i = 0; i < n; i++) {
    const t = i / sr;
    let v = 0;
    for (let h = 1; h <= 6; h++) v += (Math.sin(2 * Math.PI * freq * h * t) / h) * Math.exp(-t * (h - 1) * 5);
    const env = Math.min(1, t / 0.006) * (0.65 + 0.35 * Math.exp(-t / 0.25)) * Math.min(1, (seconds - t) / release);
    out[i] = v * env;
  }
  return out;
}

function pianoNote(sr: number, freq: number, seconds: number): Voice {
  const n = Math.round(sr * seconds);
  const out = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const t = i / sr;
    let v = 0;
    for (let h = 1; h <= 7; h++) {
      const f = freq * h * Math.sqrt(1 + 0.0004 * h * h);
      if (f > sr * 0.45) break;
      v += (Math.sin(2 * Math.PI * f * t) / h ** 1.3) * Math.exp(-t * (0.9 + 0.7 * h));
    }
    out[i] = v * Math.min(1, t / 0.003) * Math.min(1, (seconds - t) / 0.08);
  }
  return out;
}

function padNote(sr: number, freq: number, seconds: number): Voice {
  const n = Math.round(sr * seconds);
  const out = new Float32Array(n);
  const attack = Math.min(0.5, seconds * 0.3);
  const release = Math.min(0.7, seconds * 0.35);
  for (let i = 0; i < n; i++) {
    const t = i / sr;
    let v = 0;
    for (const cents of [-7, 0, 7]) {
      const f = freq * 2 ** (cents / 1200);
      v += Math.sin(2 * Math.PI * f * t) + 0.3 * Math.sin(2 * Math.PI * 2 * f * t) + 0.12 * Math.sin(2 * Math.PI * 3 * f * t);
    }
    out[i] = v * Math.min(1, t / attack) * Math.min(1, (seconds - t) / release);
  }
  return out;
}

// --- the canvas a part is written onto --------------------------------------------------

class Part {
  readonly left: Float32Array;
  readonly right: Float32Array;
  readonly frames: number;
  readonly sr: number;
  /** Frames per beat (not rounded: the positions are, one by one, so they never drift). */
  readonly beat: number;
  private readonly wrap: boolean;

  constructor(sr: number, beat: number, frames: number, wrap: boolean) {
    this.sr = sr;
    this.beat = beat;
    this.frames = frames;
    this.wrap = wrap;
    this.left = new Float32Array(frames);
    this.right = new Float32Array(frames);
  }

  /** Mix a note in at a position given in beats. `pan` runs from -1 (left) to 1 (right). */
  put(voice: Voice, atBeat: number, gain = 1, pan = 0, delaySec = 0): void {
    const start = Math.round(atBeat * this.beat + delaySec * this.sr);
    const l = gain * Math.cos(((pan + 1) * Math.PI) / 4);
    const r = gain * Math.sin(((pan + 1) * Math.PI) / 4);
    for (let i = 0; i < voice.length; i++) {
      let at = start + i;
      if (at >= this.frames) {
        if (!this.wrap) break;
        at %= this.frames;
      }
      this.left[at] += voice[i] * l;
      this.right[at] += voice[i] * r;
    }
  }
}

interface Ctx {
  part: Part;
  sr: number;
  /** Beats per bar. */
  n: number;
  bars: number;
  /** Seconds per beat. */
  beatSec: number;
  rnd: () => number;
  /** Pitch class of the key and whether it is minor. */
  pc: number;
  third: number;
}

/** The beats a snare (or clap) falls on in a bar of n beats. */
function backbeats(n: number): number[] {
  if (n === 2) return [1];
  if (n === 3) return [1, 2];
  if (n === 6) return [3];
  return [1, 3];
}

function hats(c: Ctx, gain: number, openOffbeats = false): void {
  const closed = hat(c.sr, c.rnd, false);
  const open = hat(c.sr, c.rnd, true);
  const perBeat = c.n === 6 ? 1 : 2;
  for (let b = 0; b < c.n * c.bars; b++) {
    for (let k = 0; k < perBeat; k++) {
      const off = k > 0;
      if (off && openOffbeats) c.part.put(open, b + 0.5, gain * 0.8, 0.25);
      else c.part.put(closed, b + k / perBeat, gain * (off ? 0.55 : 1), 0.25);
    }
  }
}

const RECIPES: Record<string, (c: Ctx) => void> = {
  "drums.backbeat"(c) {
    const k = kick(c.sr);
    const s = snare(c.sr, c.rnd);
    for (let bar = 0; bar < c.bars; bar++) {
      const b0 = bar * c.n;
      c.part.put(k, b0, 1);
      if (c.n >= 4) c.part.put(k, b0 + c.n / 2, 0.9);
      // A pickup kick before the last backbeat of every second bar keeps the loop from sounding like one bar.
      if (c.n === 4 && bar % 2 === 1) c.part.put(k, b0 + 2.5, 0.7);
      for (const b of backbeats(c.n)) c.part.put(s, b0 + b, c.n === 3 ? 0.6 : 0.85);
    }
    hats(c, 0.32);
  },
  "drums.four-on-the-floor"(c) {
    const k = kick(c.sr);
    const cl = clap(c.sr, c.rnd);
    for (let b = 0; b < c.n * c.bars; b++) c.part.put(k, b, 1);
    for (let bar = 0; bar < c.bars; bar++) for (const b of backbeats(c.n)) c.part.put(cl, bar * c.n + b, 0.8);
    hats(c, 0.34, c.n !== 6);
  },
  "drums.half-time"(c) {
    const k = kick(c.sr);
    const s = snare(c.sr, c.rnd);
    for (let bar = 0; bar < c.bars; bar++) {
      const b0 = bar * c.n;
      c.part.put(k, b0, 1);
      if (c.n === 4) c.part.put(k, b0 + (bar % 2 ? 1.5 : 2.75), 0.65);
      c.part.put(s, b0 + Math.floor(c.n / 2), 0.9);
    }
    hats(c, 0.26);
  },
  "percussion.shaker"(c) {
    const perBeat = c.n === 6 ? 2 : 4;
    for (let b = 0; b < c.n * c.bars; b++) {
      for (let k = 0; k < perBeat; k++) {
        const accent = k === 0 ? 1 : k === perBeat / 2 ? 0.7 : 0.4;
        c.part.put(shake(c.sr, c.rnd), b + k / perBeat, accent, -0.3);
      }
    }
  },
  "percussion.claps"(c) {
    const cl = clap(c.sr, c.rnd);
    for (let bar = 0; bar < c.bars; bar++) for (const b of backbeats(c.n)) c.part.put(cl, bar * c.n + b, 1);
  },
  "percussion.crash"(c) {
    c.part.put(crash(c.sr, c.rnd), 0, 1);
  },
  "bass.pulse"(c) {
    const root = rootAbove(c.pc, 28);
    const perBeat = c.n === 6 ? 1 : 2;
    const len = (c.beatSec / perBeat) * 0.85;
    const total = c.n * c.bars * perBeat;
    for (let i = 0; i < total; i++) {
      // The very last note steps up an octave to lead back into the loop.
      const note = i === total - 1 ? root + 12 : root;
      c.part.put(bassNote(c.sr, hz(note), len), i / perBeat, i % perBeat === 0 ? 1 : 0.8);
    }
  },
  "bass.long"(c) {
    const root = rootAbove(c.pc, 28);
    for (let bar = 0; bar < c.bars; bar++) {
      const held = c.n > 2 ? c.n - 1 : c.n;
      c.part.put(bassNote(c.sr, hz(root), held * c.beatSec * 0.95), bar * c.n, 1);
      if (c.n > 2) c.part.put(bassNote(c.sr, hz(bar % 2 ? root + 7 : root + 12), c.beatSec * 0.9), bar * c.n + held, 0.75);
    }
  },
  "guitar.strum"(c) {
    const root = rootAbove(c.pc, 40);
    const strings = [root, root + 7, root + 12, root + 12 + c.third, root + 19, root + 24];
    const ring = Math.min(2.2, c.beatSec * 2);
    const strum = (atBeat: number, down: boolean, gain: number) => {
      const order = down ? strings : [...strings.slice(2)].reverse();
      order.forEach((note, i) => {
        const pan = ((strings.indexOf(note) / (strings.length - 1)) * 2 - 1) * 0.35;
        c.part.put(pluck(c.sr, hz(note), ring, c.rnd, down ? 0.55 : 0.75), atBeat, gain * (down ? 1 : 0.8), pan, i * (down ? 0.011 : 0.007));
      });
    };
    for (let bar = 0; bar < c.bars; bar++) {
      const b0 = bar * c.n;
      if (c.n === 4) {
        // down, down-up, up-down-up
        strum(b0, true, 1);
        strum(b0 + 1, true, 0.75);
        strum(b0 + 1.5, false, 0.6);
        strum(b0 + 2.5, false, 0.65);
        strum(b0 + 3, true, 0.8);
        strum(b0 + 3.5, false, 0.6);
      } else {
        for (let b = 0; b < c.n; b++) {
          strum(b0 + b, true, b === 0 ? 1 : 0.7);
          if (c.n !== 6 && b % 2 === 1) strum(b0 + b + 0.5, false, 0.55);
        }
      }
    }
  },
  "guitar.picked"(c) {
    const root = rootAbove(c.pc, 40);
    const notes = [root, root + 7, root + 12, root + 12 + c.third, root + 19, root + 12 + c.third, root + 12, root + 7];
    const perBeat = c.n === 6 ? 1 : 2;
    const total = c.n * c.bars * perBeat;
    const ring = Math.min(2.5, c.beatSec * 3);
    for (let i = 0; i < total; i++) {
      const note = notes[i % notes.length];
      c.part.put(pluck(c.sr, hz(note), ring, c.rnd, 0.6), i / perBeat, i % (c.n * perBeat) === 0 ? 1 : 0.75, (i % 2 ? 0.25 : -0.25));
    }
  },
  "keys.piano"(c) {
    const root = rootAbove(c.pc, 48);
    const chord = [root - 12, root, root + c.third, root + 7, root + 12];
    const hit = (atBeat: number, gain: number, seconds: number) =>
      chord.forEach((note, i) => c.part.put(pianoNote(c.sr, hz(note), seconds), atBeat, gain * (i === 0 ? 0.9 : 0.7), (i - 2) * 0.15));
    for (let bar = 0; bar < c.bars; bar++) {
      const b0 = bar * c.n;
      hit(b0, 1, Math.min(3, c.beatSec * 2.5));
      if (c.n === 4) {
        hit(b0 + 1.5, 0.6, c.beatSec * 1.4);
        hit(b0 + 3, 0.7, c.beatSec);
      } else if (c.n >= 3) {
        hit(b0 + Math.ceil(c.n / 2), 0.65, c.beatSec * 1.4);
      }
    }
  },
  "keys.pad"(c) {
    const root = rootAbove(c.pc, 48);
    const voicings = [
      [root, root + 7, root + 12 + c.third],
      [root, root + c.third, root + 7, root + 14],
    ];
    for (let bar = 0; bar < c.bars; bar++) {
      // Each chord overlaps the next by a beat, and the last one wraps into the first.
      const seconds = (c.n + 1) * c.beatSec;
      voicings[bar % 2].forEach((note, i) => c.part.put(padNote(c.sr, hz(note), seconds), bar * c.n, 1, (i - 1) * 0.4));
    }
  },
};

const INFO: Array<Omit<SoundInfo, "bars">> = [
  { id: "drums.backbeat", name: "Backbeat", instrument: "drums", loop: true, pitched: false, description: "Kick and snare with closed hi-hats; the standard pop and rock beat." },
  { id: "drums.four-on-the-floor", name: "Four on the floor", instrument: "drums", loop: true, pitched: false, description: "A kick on every beat, claps on the backbeat, open hi-hats between; a dance beat." },
  { id: "drums.half-time", name: "Half-time", instrument: "drums", loop: true, pitched: false, description: "One slow snare per bar over a sparse kick; makes a song feel half as fast." },
  { id: "percussion.shaker", name: "Shaker", instrument: "percussion", loop: true, pitched: false, description: "Steady sixteenth-note shaker." },
  { id: "percussion.claps", name: "Claps", instrument: "percussion", loop: true, pitched: false, description: "Hand claps on the backbeat." },
  { id: "percussion.crash", name: "Crash", instrument: "percussion", loop: false, pitched: false, description: "One crash cymbal hit, about 3 seconds; for the start of a section." },
  { id: "bass.pulse", name: "Pulse bass", instrument: "bass", loop: true, pitched: true, description: "Driving eighth notes on the key's root." },
  { id: "bass.long", name: "Long bass", instrument: "bass", loop: true, pitched: true, description: "One long root note per bar with a passing note at the end." },
  { id: "guitar.strum", name: "Strummed guitar", instrument: "guitar", loop: true, pitched: true, description: "Acoustic-style strumming of the key's home chord." },
  { id: "guitar.picked", name: "Picked guitar", instrument: "guitar", loop: true, pitched: true, description: "Picked eighth-note arpeggio of the key's home chord." },
  { id: "keys.piano", name: "Piano chords", instrument: "keys", loop: true, pitched: true, description: "Piano chords on the home chord, a few per bar." },
  { id: "keys.pad", name: "Warm pad", instrument: "pad", loop: true, pitched: true, description: "A soft sustained chord that swells once per bar." },
];

export const SOUND_LIBRARY: SoundInfo[] = INFO.map((s) => ({ ...s, bars: s.loop ? LOOP_BARS : 0 }));

export function findSound(id: string): SoundInfo | null {
  return SOUND_LIBRARY.find((s) => s.id === id) ?? null;
}

export const INSTRUMENT_NAMES: Record<Instrument, string> = {
  drums: "Drums",
  percussion: "Percussion",
  bass: "Bass",
  guitar: "Guitar",
  keys: "Keys",
  pad: "Pad",
  audio: "Audio",
};

/** File name for a rendered library sound: the tempo (and key, when pitched) are part of what it is. */
export function soundFileName(sound: SoundInfo, opts: RenderOptions): string {
  const parts = [sound.id.replace(/[^a-z0-9]+/g, "-")];
  if (sound.loop) parts.push(`${opts.bpm.toFixed(2).replace(/\.?0+$/, "")}bpm`, `${opts.beatsPerBar}-4`);
  if (sound.pitched) {
    const k = parseKey(opts.key);
    parts.push(`${["c", "db", "d", "eb", "e", "f", "gb", "g", "ab", "a", "bb", "b"][k.pitchClass]}-${k.minor ? "minor" : "major"}`);
  }
  return `${parts.join("-")}.wav`;
}

/** Synthesise a library sound as 16-bit stereo. Loops are exactly LOOP_BARS bars long. */
export function renderSound(id: string, opts: RenderOptions): WavAudio {
  const sound = findSound(id);
  const recipe = RECIPES[id];
  if (!sound || !recipe) throw new Error(`unknown sound ${id}`);
  const sr = opts.sampleRate;
  const beatSec = 60 / opts.bpm;
  const beat = sr * beatSec;
  const n = opts.beatsPerBar;
  const frames = sound.loop ? Math.round(beat * n * LOOP_BARS) : Math.round(sr * 3);
  const part = new Part(sr, beat, frames, sound.loop);
  const key = parseKey(opts.key);
  let seed = 7;
  for (const ch of id) seed = (seed * 31 + ch.charCodeAt(0)) >>> 0;
  recipe({ part, sr, n, bars: LOOP_BARS, beatSec, rnd: prng(seed), pc: key.pitchClass, third: key.minor ? 3 : 4 });

  // Every sound leaves the library at the same peak (-6 dBFS), so clips start out balanced against each other.
  let peak = 0;
  for (let i = 0; i < frames; i++) peak = Math.max(peak, Math.abs(part.left[i]), Math.abs(part.right[i]));
  const scale = peak > 0 ? (0.5 * 32767) / peak : 0;
  const samples = new Int16Array(frames * 2);
  for (let i = 0; i < frames; i++) {
    samples[i * 2] = Math.round(part.left[i] * scale);
    samples[i * 2 + 1] = Math.round(part.right[i] * scale);
  }
  return { sampleRate: sr, channels: 2, samples };
}
