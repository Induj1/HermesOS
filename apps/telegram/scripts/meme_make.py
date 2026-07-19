#!/usr/bin/env python3
"""Add classic top/bottom meme captions to an image.

Usage: python meme_make.py <input> <output.png> "<top>" "<bottom>"
White uppercase text with a black outline, wrapped to the image width.
"""
import sys
import textwrap

from PIL import Image, ImageDraw, ImageFont

in_path, out_path, top, bottom = sys.argv[1], sys.argv[2], sys.argv[3], sys.argv[4]

img = Image.open(in_path).convert("RGB")
W, H = img.size
draw = ImageDraw.Draw(img)


def load_font(size):
    for path in (
        "/System/Library/Fonts/Supplemental/Impact.ttf",
        "/Library/Fonts/Impact.ttf",
        "/System/Library/Fonts/Supplemental/Arial Bold.ttf",
        "/System/Library/Fonts/Helvetica.ttc",
    ):
        try:
            return ImageFont.truetype(path, size)
        except OSError:
            continue
    from matplotlib import font_manager

    return ImageFont.truetype(font_manager.findfont("DejaVu Sans:bold"), size)


def draw_caption(text, top_anchor):
    if not text:
        return
    text = text.upper()
    size = max(20, W // 12)
    font = load_font(size)
    wrap = max(1, W // (size // 2 + 1))
    lines = textwrap.wrap(text, width=wrap) or [text]
    line_h = size + 8
    total = line_h * len(lines)
    y = 10 if top_anchor else H - total - 10
    for line in lines:
        bbox = draw.textbbox((0, 0), line, font=font)
        x = (W - (bbox[2] - bbox[0])) // 2
        draw.text(
            (x, y),
            line,
            font=font,
            fill="white",
            stroke_width=max(2, size // 12),
            stroke_fill="black",
        )
        y += line_h


draw_caption(top, True)
draw_caption(bottom, False)
img.save(out_path)
print(out_path)
