# Test fixtures

Two 16-second clips (48 kHz, stereo, 16-bit PCM) cut from the ACE-Step spike
output in `~/song-studio/spike/audio/`, seconds 21.5–37.5 of each file:

- `folk_orig_16s.wav` — from `02_folk_orig.wav` (a text2music result)
- `folk_repaint_16s.wav` — from `02_folk_repaint.wav` (the real repaint of that
  song over 23.0–36.0 s, which is 1.5–14.5 s in these clips). Outside the range
  it equals the original times a uniform gain of about −0.52 dB.

They are used by the splice tests (a real model pair) and by the mock ACE-Step
server as its source of audio.

`folk_whisper_words.json` is what Whisper (large-v3-turbo on MLX, word
timestamps) heard in a real 30 s take, together with the lyrics that take was
asked to sing. The take was made before the lyric-clarity fixes, so only the
verse was sung clearly; the alignment tests use it as a realistic messy case.
