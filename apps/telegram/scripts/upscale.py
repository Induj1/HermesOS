#!/usr/bin/env python3
"""AI super-resolution: 4x upscale/restore a photo (Stable Diffusion x4 upscaler).

Usage: python upscale.py <input> <output.png>
The input is capped to 256px on its long side first (the x4 model is memory
heavy), so the result is up to ~1024px, sharper and denoised. Model downloads
once (~1.5GB).
"""
import sys

import torch
from diffusers import StableDiffusionUpscalePipeline
from PIL import Image

in_path = sys.argv[1]
out_path = sys.argv[2]

device = "mps" if torch.backends.mps.is_available() else "cpu"
pipe = StableDiffusionUpscalePipeline.from_pretrained(
    "stabilityai/stable-diffusion-x4-upscaler", torch_dtype=torch.float32
).to(device)
pipe.set_progress_bar_config(disable=True)

img = Image.open(in_path).convert("RGB")
img.thumbnail((256, 256))  # keep the x4 output and memory reasonable

result = pipe(
    prompt="high resolution, sharp, detailed, high quality photo",
    image=img,
    num_inference_steps=30,
    guidance_scale=0.0,
).images[0]
result.save(out_path)
print(out_path)
