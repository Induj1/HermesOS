#!/usr/bin/env python3
"""Turn a photo into a Telegram sticker: cut out the subject, fit to 512px, WebP.

Usage: python sticker_make.py <input> <output.webp>
"""
import io
import sys

from PIL import Image
from rembg import remove

in_path = sys.argv[1]
out_path = sys.argv[2]

with open(in_path, "rb") as f:
    cut = remove(f.read())

img = Image.open(io.BytesIO(cut)).convert("RGBA")
img.thumbnail((512, 512))  # longest side becomes 512, preserving aspect
img.save(out_path, "WEBP")
print(out_path)
