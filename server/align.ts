// Where things are in the song: lines and sections in time.
//
// The music model reports no timings, so the app listens instead: Whisper
// transcribes each finished take with word timestamps, and this module aligns
// the words it heard to the take's lyrics. A lyric word that Whisper heard gets
// Whisper's time; a line spans its first to its last heard word; a section
// ("chorus 2") spans its lines, padded a little so that a repaint of it keeps
// the pickup into the first word and does not clip the next section.
//
// Everything here is pure and synchronous; running Whisper lives in transcribe.ts.

import type { DetectedLine, DetectedSection, HeardWord, TakeTiming } from "./types.ts";

/** Lowercase letters and digits only, so "Folded-up," and "folded up" compare as words. */
export function normalizeWord(w: string): string {
  return w
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, "");
}

function words(text: string): string[] {
  return text
    .split(/[\s\-–—/]+/)
    .map(normalizeWord)
    .filter(Boolean);
}

interface LyricLine {
  section: string;
  text: string;
  words: string[];
}

interface LyricBlock {
  /** The tag as written, without brackets ("chorus", "guitar solo"). */
  tag: string;
  lines: LyricLine[];
}

/** Splits lyrics into tagged blocks. Lines before the first tag form a block called "lyrics". */
export function parseLyrics(lyrics: string): LyricBlock[] {
  const blocks: LyricBlock[] = [];
  let cur: LyricBlock | null = null;
  for (const raw of lyrics.split("\n")) {
    const tag = /^\s*\[([^\]]+)\]\s*$/.exec(raw);
    if (tag) {
      cur = { tag: tag[1].trim().toLowerCase().replace(/\s+/g, " "), lines: [] };
      blocks.push(cur);
      continue;
    }
    const text = raw.replace(/\[[^\]]*\]/g, "").trim();
    const w = words(text);
    if (!w.length) continue;
    if (!cur) {
      cur = { tag: "lyrics", lines: [] };
      blocks.push(cur);
    }
    cur.lines.push({ section: cur.tag, text, words: w });
  }
  return blocks;
}

/** Labels blocks the way people say them: a tag that occurs more than once is numbered ("chorus 1", "chorus 2"). */
export function sectionLabels(blocks: { tag: string }[]): string[] {
  const total = new Map<string, number>();
  for (const b of blocks) total.set(b.tag, (total.get(b.tag) ?? 0) + 1);
  const seen = new Map<string, number>();
  return blocks.map((b) => {
    const n = (seen.get(b.tag) ?? 0) + 1;
    seen.set(b.tag, n);
    // "[verse 1]" is already numbered; do not make it "verse 1 1".
    return (total.get(b.tag) ?? 0) > 1 && !/\d$/.test(b.tag) ? `${b.tag} ${n}` : b.tag;
  });
}

function editDistance(a: string, b: string): number {
  if (a === b) return 0;
  const prev = new Array(b.length + 1);
  for (let j = 0; j <= b.length; j++) prev[j] = j;
  for (let i = 1; i <= a.length; i++) {
    let diag = prev[0];
    prev[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const up = prev[j];
      prev[j] = Math.min(prev[j] + 1, prev[j - 1] + 1, diag + (a[i - 1] === b[j - 1] ? 0 : 1));
      diag = up;
    }
  }
  return prev[b.length];
}

/** 1 for the same word, down to 0 for unrelated ones. Short words must match exactly. */
export function wordSimilarity(a: string, b: string): number {
  if (a === b) return 1;
  if (a.length < 3 || b.length < 3) return 0;
  return Math.max(0, 1 - editDistance(a, b) / Math.max(a.length, b.length));
}

const MATCH_MIN = 0.6;
const GAP_LYRIC = -0.6; // a lyric word Whisper did not hear
const GAP_HEARD = -0.4; // a heard word that is not in the lyrics (inside the sung part)

/**
 * Global alignment of lyric words to heard words (Needleman-Wunsch), with free
 * heard words before the first and after the last lyric word, since Whisper
 * often hallucinates over an instrumental intro or outro.
 * Returns, for each lyric word, the index of the heard word it matched, or -1.
 */
export function alignWords(lyric: string[], heard: string[]): number[] {
  const n = lyric.length;
  const m = heard.length;
  const W = m + 1;
  const score = new Float64Array((n + 1) * W);
  const move = new Uint8Array((n + 1) * W); // 1 diag, 2 up (skip lyric), 3 left (skip heard)
  for (let j = 1; j <= m; j++) {
    score[j] = 0; // leading heard words are free
    move[j] = 3;
  }
  for (let i = 1; i <= n; i++) {
    score[i * W] = score[(i - 1) * W] + GAP_LYRIC;
    move[i * W] = 2;
    for (let j = 1; j <= m; j++) {
      const sim = wordSimilarity(lyric[i - 1], heard[j - 1]);
      const diag = score[(i - 1) * W + j - 1] + (sim >= MATCH_MIN ? 1 + sim : -1);
      const up = score[(i - 1) * W + j] + GAP_LYRIC;
      const left = score[i * W + j - 1] + (i === n ? 0 : GAP_HEARD); // trailing heard words are free
      let best = diag;
      let mv = 1;
      if (up > best) {
        best = up;
        mv = 2;
      }
      if (left > best) {
        best = left;
        mv = 3;
      }
      score[i * W + j] = best;
      move[i * W + j] = mv;
    }
  }
  const out = new Array<number>(n).fill(-1);
  let i = n;
  let j = m;
  while (i > 0 && j >= 0) {
    const mv = j === 0 ? 2 : move[i * W + j];
    if (mv === 1) {
      if (wordSimilarity(lyric[i - 1], heard[j - 1]) >= MATCH_MIN) out[i - 1] = j - 1;
      i--;
      j--;
    } else if (mv === 2) i--;
    else j--;
  }
  return out;
}

/** A line is placed in time only when at least this many of its words, and this share of them, were heard. */
const MIN_LINE_WORDS = 2;
const MIN_LINE_RATIO = 0.3;
/** Lead-in kept before a section's first word, so a repaint keeps the pickup. */
const LEAD_SEC = 0.35;
/** A tagged part with no lines (an intro, a solo) needs at least this much room to be marked. */
const MIN_INSTRUMENTAL_SEC = 1;

function r2(v: number): number {
  return Math.round(v * 100) / 100;
}

/**
 * Builds line and section timings for one take from the words Whisper heard.
 * `durationSec` is the take's length; `model` names the transcriber.
 */
export function alignLyrics(lyrics: string, heard: HeardWord[], durationSec: number, model: string): TakeTiming {
  const blocks = parseLyrics(lyrics);
  const labels = sectionLabels(blocks);
  const lyricWords: { block: number; line: number; word: string }[] = [];
  blocks.forEach((b, bi) => b.lines.forEach((l, li) => l.words.forEach((w) => lyricWords.push({ block: bi, line: li, word: w }))));
  const heardNorm = heard.map((h) => normalizeWord(h.w));
  const match = alignWords(
    lyricWords.map((w) => w.word),
    heardNorm,
  );

  // Lines.
  const lines: DetectedLine[] = [];
  const lineRefs: { block: number; line: number; out: DetectedLine }[] = [];
  let k = 0;
  blocks.forEach((b, bi) =>
    b.lines.forEach((l, li) => {
      const idx: number[] = [];
      for (let w = 0; w < l.words.length; w++, k++) if (match[k] >= 0) idx.push(match[k]);
      // One stray word ("my", "the") lines up with almost anything; a line needs real evidence to be placed.
      const placed = idx.length >= Math.min(MIN_LINE_WORDS, l.words.length) && idx.length / l.words.length >= MIN_LINE_RATIO;
      const out: DetectedLine = {
        section: labels[bi],
        text: l.text,
        startSec: placed ? r2(heard[idx[0]].t0) : null,
        endSec: placed ? r2(heard[idx[idx.length - 1]].t1) : null,
        wordsHeard: idx.length,
        words: l.words.length,
      };
      lines.push(out);
      lineRefs.push({ block: bi, line: li, out });
    }),
  );

  // Sung extent of each block.
  const sung = blocks.map((_, bi) => {
    const ls = lineRefs.filter((r) => r.block === bi && r.out.startSec !== null).map((r) => r.out);
    return ls.length ? { start: ls[0].startSec!, end: ls[ls.length - 1].endSec! } : null;
  });

  // Sections: sung blocks first, then instrumental blocks fill the gaps they sit in.
  const sections: DetectedSection[] = [];
  const firstSungAfter = (bi: number) => {
    for (let x = bi + 1; x < blocks.length; x++) if (sung[x]) return sung[x]!.start;
    return null;
  };
  const lastSungBefore = (bi: number) => {
    for (let x = bi - 1; x >= 0; x--) if (sung[x]) return sung[x]!.end;
    return null;
  };
  blocks.forEach((b, bi) => {
    const words = b.lines.reduce((s, l) => s + l.words.length, 0);
    const heardCount = lineRefs.filter((r) => r.block === bi).reduce((s, r) => s + r.out.wordsHeard, 0);
    if (b.lines.length) {
      if (!sung[bi]) return; // nothing of it was heard: its place in the song is unknown
      const prevEnd = lastSungBefore(bi);
      const nextStart = firstSungAfter(bi);
      const start = Math.max(prevEnd ?? 0, sung[bi]!.start - LEAD_SEC);
      // Run up to the next sung section's lead-in, so that the tail of the last line (held notes, reverb) belongs here.
      const end = nextStart !== null ? Math.max(sung[bi]!.end, nextStart - LEAD_SEC) : Math.min(durationSec, sung[bi]!.end + 1.5);
      sections.push({ label: labels[bi], startSec: r2(Math.max(0, start)), endSec: r2(Math.min(durationSec, end)), wordsHeard: heardCount, words, kind: "sung" });
    } else {
      const prevEnd = lastSungBefore(bi);
      const nextStart = firstSungAfter(bi);
      const start = prevEnd ?? 0;
      const end = nextStart !== null ? nextStart - LEAD_SEC : durationSec;
      if (end - start >= MIN_INSTRUMENTAL_SEC) sections.push({ label: labels[bi], startSec: r2(start), endSec: r2(end), wordsHeard: 0, words: 0, kind: "instrumental" });
    }
  });
  sections.sort((a, b) => a.startSec - b.startSec);
  // Instrumental parts take their room from their neighbours: trim overlaps so sections never overlap.
  for (let s = 1; s < sections.length; s++) {
    const a = sections[s - 1];
    const b = sections[s];
    if (b.startSec < a.endSec) {
      if (b.kind === "instrumental") a.endSec = b.startSec;
      else b.startSec = a.endSec;
    }
  }

  const totalWords = lyricWords.length;
  const matched = match.filter((x) => x >= 0).length;
  return {
    model,
    heardText: heard.map((h) => h.w).join(" "),
    words: heard,
    lines,
    sections: sections.filter((s) => s.endSec - s.startSec >= 0.5),
    lyricWords: totalWords,
    lyricWordsHeard: matched,
  };
}

/** Lines whose sung time overlaps [startSec, endSec]. */
export function linesInRange(timing: TakeTiming, startSec: number, endSec: number): DetectedLine[] {
  return timing.lines.filter((l) => l.startSec !== null && l.endSec !== null && l.endSec > startSec && l.startSec < endSec);
}
