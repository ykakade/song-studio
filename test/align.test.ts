// Lining up what Whisper heard with the lyrics: lines and sections in time.

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { alignLyrics, alignWords, linesInRange, normalizeWord, parseLyrics, sectionLabels } from "../server/align.ts";
import { evenlySpaced } from "../server/transcribe.ts";
import type { HeardWord } from "../server/types.ts";
import { FIXTURES } from "./helpers.ts";

const SONG = `[intro]

[verse]
Rain on the rooftops, rain on the street
Folded paper beneath my feet

[chorus]
Float on, paper boats, down to the sea
Hold on to the water, hold on to me

[guitar solo]

[verse]
Little white boats in the gutter stream
Sailing away like a quiet dream

[chorus]
Float on, paper boats, down to the sea
Hold on to the water, hold on to me`;

/** Words of `text` sung from `from` to `to` seconds. */
function sing(text: string, from: number, to: number): HeardWord[] {
  return evenlySpaced(text, from, to);
}

test("align: words are compared without case, punctuation or accents", () => {
  assert.equal(normalizeWord("Rooftops,"), "rooftops");
  assert.equal(normalizeWord("Café"), "cafe");
  assert.equal(normalizeWord("we'll"), "well");
});

test("align: tags become sections; repeated tags are numbered, already numbered ones are not", () => {
  const blocks = parseLyrics(SONG);
  assert.deepEqual(blocks.map((b) => b.tag), ["intro", "verse", "chorus", "guitar solo", "verse", "chorus"]);
  assert.deepEqual(sectionLabels(blocks), ["intro", "verse 1", "chorus 1", "guitar solo", "verse 2", "chorus 2"]);
  assert.deepEqual(sectionLabels([{ tag: "verse 1" }, { tag: "verse 2" }, { tag: "chorus" }]), ["verse 1", "verse 2", "chorus"]);
  assert.deepEqual(parseLyrics("no tags here\nsecond line").map((b) => [b.tag, b.lines.length]), [["lyrics", 2]]);
});

test("align: a cleanly sung song gets every line and section, with instrumental parts in the gaps", () => {
  const heard = [
    ...sing("Rain on the rooftops, rain on the street", 8, 11),
    ...sing("Folded paper beneath my feet", 11.5, 14),
    ...sing("Float on, paper boats, down to the sea", 15, 18),
    ...sing("Hold on to the water, hold on to me", 18.5, 22),
    // 22-30: guitar solo
    ...sing("Little white boats in the gutter stream", 30, 33),
    ...sing("Sailing away like a quiet dream", 33.5, 36),
    ...sing("Float on, paper boats, down to the sea", 37, 40),
    ...sing("Hold on to the water, hold on to me", 40.5, 44),
  ];
  const t = alignLyrics(SONG, heard, 50, "test");
  assert.equal(t.lyricWordsHeard, t.lyricWords);
  assert.deepEqual(
    t.sections.map((s) => [s.label, s.kind]),
    [["intro", "instrumental"], ["verse 1", "sung"], ["chorus 1", "sung"], ["guitar solo", "instrumental"], ["verse 2", "sung"], ["chorus 2", "sung"]],
  );
  const by = Object.fromEntries(t.sections.map((s) => [s.label, s]));
  assert.equal(by["intro"].startSec, 0);
  assert.equal(by["intro"].endSec, 7.65, "the intro ends just before the first word");
  assert.equal(by["verse 1"].startSec, 7.65, "a section starts a little before its first word, keeping the pickup");
  assert.equal(by["chorus 2"].startSec, 36.65);
  assert.ok(by["chorus 2"].endSec > 44 && by["chorus 2"].endSec <= 50, "the last section keeps the tail of its last line");
  assert.ok(by["guitar solo"].startSec >= by["chorus 1"].startSec && by["guitar solo"].endSec <= by["verse 2"].startSec);
  for (let i = 1; i < t.sections.length; i++) {
    assert.ok(t.sections[i].startSec >= t.sections[i - 1].endSec, `${t.sections[i].label} overlaps ${t.sections[i - 1].label}`);
  }
  // Lines in a range: what a selection covers.
  assert.deepEqual(linesInRange(t, 37, 39).map((l) => l.text), ["Float on, paper boats, down to the sea"]);
  assert.equal(t.lines[0].section, "verse 1");
  assert.equal(t.lines[0].startSec, 8);
});

test("align: repeated choruses are told apart by their order in the song", () => {
  const heard = [
    ...sing("Float on, paper boats, down to the sea", 15, 18),
    ...sing("Float on, paper boats, down to the sea", 37, 40),
  ];
  const t = alignLyrics(SONG, heard, 50, "test");
  const first = t.lines.filter((l) => l.text.startsWith("Float on"));
  assert.equal(first.length, 2);
  assert.ok(first[0].startSec! < 20 && first[1].startSec! > 30, "first chorus line early, second late");
  assert.deepEqual(t.sections.filter((s) => s.kind === "sung").map((s) => s.label), ["chorus 1", "chorus 2"], "sections nobody heard are left out");
});

test("align: Whisper's words over the intro and outro do not pull lines out of place", () => {
  const heard = [
    ...sing("Thank you for watching", 0, 3), // the classic hallucination over music
    ...sing("Rain on the rooftops, rain on the street", 8, 11),
    ...sing("Folded paper beneath my feet", 11.5, 14),
    ...sing("Subtitles by the community", 46, 49),
  ];
  const t = alignLyrics(SONG, heard, 50, "test");
  assert.equal(t.lines[0].startSec, 8);
  assert.ok(t.lines[1].endSec! <= 14);
});

test("align: a hallucinated 'Thank you.' over unclear vocals places nothing", () => {
  const t = alignLyrics(SONG, sing("Thank you.", 0, 2), 50, "test");
  assert.equal(t.lyricWordsHeard, 0);
  assert.deepEqual(t.sections.filter((s) => s.kind === "sung"), []);
  assert.ok(t.lines.every((l) => l.startSec === null));
});

test("align: misheard words still line up; a single stray match does not place a line", () => {
  const m = alignWords(["sailing", "away", "like", "a", "quiet", "dream"], ["sailing", "away", "like", "youre", "quite", "my", "feet"]);
  assert.deepEqual(m.slice(0, 3), [0, 1, 2]);
  assert.equal(m[4], 4, '"quiet" matches "quite"');
  assert.equal(m[5], -1, '"dream" does not match "feet"');
});

test("align (real Whisper output): the clearly sung verse is found, the unsung chorus is not invented", () => {
  const fx = JSON.parse(readFileSync(path.join(FIXTURES, "folk_whisper_words.json"), "utf8"));
  const t = alignLyrics(fx.lyrics, fx.words, fx.durationSec, "whisper");
  assert.deepEqual(t.sections.map((s) => s.label), ["verse"]);
  const verse = t.sections[0];
  assert.ok(verse.startSec > 0.5 && verse.startSec < 2, `verse starts ${verse.startSec}`);
  assert.ok(verse.endSec > 19 && verse.endSec <= 22, `verse ends ${verse.endSec}`);
  assert.deepEqual(
    t.lines.slice(0, 4).map((l) => l.startSec !== null),
    [true, true, true, true],
    "all four verse lines are placed",
  );
  assert.ok(t.lines.slice(4).every((l) => l.startSec === null), "no chorus line is placed: it was not sung clearly");
  assert.ok(t.lyricWordsHeard >= 18 && t.lyricWordsHeard <= 22);
});
