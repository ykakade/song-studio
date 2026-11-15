"""Word-level transcription of a 16-bit PCM WAV with Whisper (MLX, runs on Apple silicon).

Usage: transcribe.py <file.wav> [language]
Prints one JSON object to stdout: {"model": ..., "text": ..., "words": [{"w", "t0", "t1", "p"}]}.
Needs no ffmpeg: the WAV is read and resampled here. Run it through uv (see server/align.ts).
"""
import json
import sys
import wave

import numpy as np
from scipy.signal import resample_poly
import mlx_whisper

MODEL = "mlx-community/whisper-large-v3-turbo"


def main() -> None:
    path = sys.argv[1]
    language = sys.argv[2] if len(sys.argv) > 2 and sys.argv[2] else None
    with wave.open(path, "rb") as w:
        if w.getsampwidth() != 2:
            raise SystemExit("only 16-bit PCM WAV is supported")
        sr, ch = w.getframerate(), w.getnchannels()
        x = np.frombuffer(w.readframes(w.getnframes()), dtype="<i2").astype(np.float32) / 32768.0
    x = x.reshape(-1, ch).mean(axis=1)
    x = resample_poly(x, 16000, sr).astype(np.float32)
    r = mlx_whisper.transcribe(
        x,
        path_or_hf_repo=MODEL,
        language=language,
        word_timestamps=True,
        condition_on_previous_text=False,
        temperature=0.0,
        verbose=None,
    )
    words = [
        {"w": wd["word"].strip(), "t0": round(float(wd["start"]), 3), "t1": round(float(wd["end"]), 3), "p": round(float(wd.get("probability", 0.0)), 3)}
        for seg in r["segments"]
        for wd in seg.get("words", [])
        if wd["word"].strip()
    ]
    json.dump({"model": MODEL, "text": r["text"].strip(), "words": words}, sys.stdout)


if __name__ == "__main__":
    main()
