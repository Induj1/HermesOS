#!/usr/bin/env python3
"""Remove an image's background, producing a transparent PNG cutout (rembg).

Usage: python rembg_remove.py <input> <output.png>
Model (u2net, ~170MB) downloads once on first run and is cached under ~/.u2net.
"""
import sys

from rembg import remove

in_path = sys.argv[1]
out_path = sys.argv[2]

with open(in_path, "rb") as f:
    data = f.read()

with open(out_path, "wb") as f:
    f.write(remove(data))

print(out_path)
