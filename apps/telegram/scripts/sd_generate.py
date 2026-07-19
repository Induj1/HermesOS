#!/usr/bin/env python3
"""Generate an image from a text prompt with Stable Diffusion (sd-turbo) on MPS.

Usage: python sd_generate.py "<prompt>" <output.png>
The model downloads on first run (~2.5GB) and is cached thereafter.
"""
import sys

import torch
from diffusers import AutoPipelineForText2Image

prompt = sys.argv[1]
out_path = sys.argv[2]

pipe = AutoPipelineForText2Image.from_pretrained("stabilityai/sd-turbo")
pipe = pipe.to("mps" if torch.backends.mps.is_available() else "cpu")

image = pipe(prompt=prompt, num_inference_steps=1, guidance_scale=0.0).images[0]
image.save(out_path)
print(out_path)
