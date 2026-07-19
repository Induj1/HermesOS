#!/usr/bin/env python3
"""Transform an image with a text prompt (Stable Diffusion img2img, sd-turbo).

Usage: python sd_img2img.py "<prompt>" <input.png> <output.png>
"""
import sys

import torch
from diffusers import AutoPipelineForImage2Image
from diffusers.utils import load_image

prompt = sys.argv[1]
in_path = sys.argv[2]
out_path = sys.argv[3]

pipe = AutoPipelineForImage2Image.from_pretrained("stabilityai/sd-turbo")
pipe = pipe.to("mps" if torch.backends.mps.is_available() else "cpu")

init_image = load_image(in_path).convert("RGB").resize((512, 512))
image = pipe(
    prompt=prompt,
    image=init_image,
    num_inference_steps=2,
    strength=0.65,
    guidance_scale=0.0,
).images[0]
image.save(out_path)
print(out_path)
