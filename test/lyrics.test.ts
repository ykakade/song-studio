import assert from "node:assert/strict";
import { test } from "node:test";
import { countSungWords, durationForWords, sungLines, wordBudget } from "../server/lyrics.ts";

test("lyrics: only sung words count, not section tags or blank lines", () => {
  const lyrics = "[verse]\nRain on the rooftops, rain on the street\n\n[guitar solo]\n\n[chorus]\nFloat on (float on)\n—";
  assert.deepEqual(sungLines(lyrics), ["Rain on the rooftops, rain on the street", "Float on (float on)"]);
  assert.equal(countSungWords(lyrics), 12);
  assert.equal(countSungWords("[instrumental]"), 0);
  assert.equal(countSungWords("[verse] sung on the tag line"), 5);
  // Scripts without spaces: two characters count as one word.
  assert.equal(countSungWords("[verse]\n我站在窗前\n看着外面世界"), 6);
});

test("lyrics: the word budget follows duration and tempo", () => {
  assert.equal(wordBudget(30, 92), 30);
  assert.equal(wordBudget(60, 92), 76);
  assert.equal(wordBudget(120, 92), 168);
  assert.equal(wordBudget(30, 110), 36);
  // Songs under 30 s reserve a third of their length for the intro instead of 10 s.
  assert.equal(wordBudget(12, 96), 12);
  // Very fast and very slow tempos are clamped to 2 and 1.33 words per second.
  assert.equal(wordBudget(34, 200), 48);
  assert.equal(wordBudget(34, 50), 32);
  // The first take the user found unclear: 60 words in a 30 s song at 92 bpm.
  const crowded =
    "[verse]\nRain on the rooftops, rain on the street\nFolded-up paper beneath my feet\nLittle white boats in the gutter stream\nSailing away like a quiet dream\n\n" +
    "[chorus]\nFloat on, paper boats, down the rainy lane\nCarry my wishes through the window pane\nFloat on, paper boats, till the clouds go by\nHold on to the water, hold on to the sky";
  assert.equal(countSungWords(crowded), 60);
  assert.ok(countSungWords(crowded) > wordBudget(30, 92));
});

test("lyrics: durationForWords gives a duration whose budget covers the words", () => {
  for (const bpm of [50, 92, 120, 200]) {
    for (const words of [4, 12, 60, 150]) {
      const d = durationForWords(words, bpm);
      assert.ok(wordBudget(d, bpm) >= words, `${words} words at ${bpm} bpm fit in ${d} s`);
      assert.ok(wordBudget(d - 2, bpm) < words, `${d} s is not far more than needed`);
    }
  }
});
