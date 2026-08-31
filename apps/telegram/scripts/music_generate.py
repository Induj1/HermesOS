#!/usr/bin/env python3
"""Generate a short music clip from a text prompt (MusicGen via transformers).

Usage: python music_generate.py "<prompt>" <output.wav>
Reuses the existing torch venv — no audiocraft needed. Model downloads once (~2GB).
"""
import sys

import scipy.io.wavfile
from transformers import AutoProcessor, MusicgenForConditionalGeneration

prompt = sys.argv[1]
out_path = sys.argv[2]

processor = AutoProcessor.from_pretrained("facebook/musicgen-small")
model = MusicgenForConditionalGeneration.from_pretrained("facebook/musicgen-small")

inputs = processor(text=[prompt], padding=True, return_tensors="pt")
audio = model.generate(**inputs, max_new_tokens=256)  # ~5 seconds

rate = model.config.audio_encoder.sampling_rate
scipy.io.wavfile.write(out_path, rate=rate, data=audio[0, 0].numpy())
print(out_path)
