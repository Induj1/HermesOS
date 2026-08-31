#!/usr/bin/env python3
"""Split a song into vocals and instrumental (Demucs two-stem separation).

Usage: python stem_split.py <input_audio> <out_vocals.mp3> <out_instrumental.mp3>
Runs Demucs (htdemucs) and copies the two stems to the given paths. The model
downloads once (~80MB).
"""
import os
import shutil
import sys
import tempfile

import demucs.separate

in_path = sys.argv[1]
out_vocals = sys.argv[2]
out_instrumental = sys.argv[3]

work = tempfile.mkdtemp(prefix="hermes-demucs-")
demucs.separate.main(
    ["--two-stems", "vocals", "--mp3", "-n", "htdemucs", "-o", work, in_path]
)

base = os.path.splitext(os.path.basename(in_path))[0]
stem_dir = os.path.join(work, "htdemucs", base)
shutil.copy(os.path.join(stem_dir, "vocals.mp3"), out_vocals)
shutil.copy(os.path.join(stem_dir, "no_vocals.mp3"), out_instrumental)
shutil.rmtree(work, ignore_errors=True)
print("ok")
