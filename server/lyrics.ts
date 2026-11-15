// How many words a song has room for. The music model has to fit every lyric
// line into the requested duration; given too many words it rushes or slurs
// them or never reaches the last lines. The studio therefore refuses
// lyrics that are over budget instead of sending them to the model.

/**
 * Seconds left free for the intro. Measured on 30 s songs with the LM planner:
 * the vocal enters anywhere between 0 and 10 s, and the lines that no longer fit
 * before the end are simply not sung. Short songs reserve a third of their length.
 */
const MAX_RESERVED_SEC = 10;
function reservedSeconds(durationSec: number): number {
  return Math.min(MAX_RESERVED_SEC, durationSec / 3);
}

/** A comfortably sung line is about eight words over two bars. */
const WORDS_PER_BAR = 4;
/** Bars shorter or longer than this stop being a useful measure of singing speed. */
const MIN_BAR_SEC = 2;
const MAX_BAR_SEC = 3;

const CJK = /[\u3040-\u30ff\u3400-\u4dbf\u4e00-\u9fff\uac00-\ud7af]/g;

/** Sung lines: everything except blank lines and section tags like [verse]. */
export function sungLines(lyrics: string): string[] {
  return lyrics
    .split("\n")
    .map((l) => l.replace(/\[[^\]]*\]/g, "").trim())
    .filter((l) => /[\p{L}\p{N}]/u.test(l));
}

/** Words that have to be sung. Scripts without spaces count two characters as one word. */
export function countSungWords(lyrics: string): number {
  let words = 0;
  for (const line of sungLines(lyrics)) {
    const cjk = line.match(CJK)?.length ?? 0;
    const rest = line.replace(CJK, " ");
    words += Math.ceil(cjk / 2) + rest.split(/\s+/).filter((w) => /[\p{L}\p{N}]/u.test(w)).length;
  }
  return words;
}

function barSeconds(bpm: number, timeSignature: string): number {
  const beats = Number(timeSignature) || 4;
  return Math.min(MAX_BAR_SEC, Math.max(MIN_BAR_SEC, (beats * 60) / bpm));
}

/** The most sung words a song of this length and tempo can carry clearly. */
export function wordBudget(durationSec: number, bpm: number, timeSignature = "4"): number {
  const bars = Math.max(0, durationSec - reservedSeconds(durationSec)) / barSeconds(bpm, timeSignature);
  return Math.floor(bars * WORDS_PER_BAR);
}

/** The shortest duration, in whole seconds, whose budget covers this many words. */
export function durationForWords(words: number, bpm: number, timeSignature = "4"): number {
  const singing = (words / WORDS_PER_BAR) * barSeconds(bpm, timeSignature);
  return Math.ceil(singing >= 2 * MAX_RESERVED_SEC ? singing + MAX_RESERVED_SEC : singing * 1.5);
}
