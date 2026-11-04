#!/usr/bin/env python3
"""Make the audio for the BUS-138 PR C Whisper-prompt eval (opt-in, offline).

One 16 kHz mono s16le file per corpus sentence (`<id>.s16`), spoken by a Piper
voice. Nothing here records or uses a person's voice.

  python3 -m venv --system-site-packages /workspace/piper-venv
  /workspace/piper-venv/bin/pip install --no-deps piper-tts   # needs onnxruntime
  /workspace/piper-venv/bin/python scripts/dictionary-prompt-eval-tts.py \
      VOICE.onnx OUT_DIR [--field said|heard_by_b2]

`--field said` (default) is what the speaker says; `heard_by_b2` is B2's
mishearing text, said as written. Keep sentences have no `heard_by_b2`, so
they are skipped for that field.
"""
import argparse
import json
import pathlib
import subprocess

from piper import PiperVoice

CORPUS = (pathlib.Path(__file__).resolve().parent.parent
          / "src-tauri/src/stt/fixtures/dictionary_prompt/corpus.json")


def to_16k_mono(pcm: bytes, rate: int) -> bytes:
    return subprocess.run(
        ["ffmpeg", "-v", "error", "-f", "s16le", "-ar", str(rate), "-ac", "1",
         "-i", "-", "-ar", "16000", "-ac", "1", "-f", "s16le", "-"],
        input=pcm, stdout=subprocess.PIPE, check=True).stdout


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("voice")
    parser.add_argument("out")
    parser.add_argument("--field", default="said",
                        choices=["said", "heard_by_b2"])
    args = parser.parse_args()
    voice = PiperVoice.load(args.voice)
    out = pathlib.Path(args.out)
    out.mkdir(parents=True, exist_ok=True)
    for item in json.loads(CORPUS.read_text())["items"]:
        text = item.get(args.field)
        if not text:
            continue
        pcm = b"".join(c.audio_int16_bytes for c in voice.synthesize(text))
        (out / f"{item['id']}.s16").write_bytes(
            to_16k_mono(pcm, voice.config.sample_rate))


if __name__ == "__main__":
    main()
