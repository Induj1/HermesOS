#!/usr/bin/env python3
"""Generate a short animated clip from a text prompt (sd-turbo latent walk).

Usage: python video_generate.py "<prompt>" <output.mp4> [num_frames] [fps]

Renders N frames of the same prompt while spherically interpolating (slerp)
between two random noise latents, so the scene morphs smoothly, then encodes
them to an MP4 with imageio. Reuses the existing torch + diffusers venv.
"""
import sys

import numpy as np
import torch
import imageio.v2 as imageio
from diffusers import AutoPipelineForText2Image

prompt = sys.argv[1]
out_path = sys.argv[2]
num_frames = int(sys.argv[3]) if len(sys.argv) > 3 else 16
fps = int(sys.argv[4]) if len(sys.argv) > 4 else 8

device = "mps" if torch.backends.mps.is_available() else "cpu"
pipe = AutoPipelineForText2Image.from_pretrained(
    "stabilityai/sd-turbo", torch_dtype=torch.float32
).to(device)
pipe.set_progress_bar_config(disable=True)


def slerp(t, a, b):
    """Spherical linear interpolation between two flat noise tensors."""
    a_n = a / torch.norm(a)
    b_n = b / torch.norm(b)
    omega = torch.acos(torch.clamp((a_n * b_n).sum(), -1.0, 1.0))
    so = torch.sin(omega)
    if so.abs() < 1e-6:
        return (1.0 - t) * a + t * b
    return torch.sin((1.0 - t) * omega) / so * a + torch.sin(t * omega) / so * b


gen = torch.Generator("cpu").manual_seed(0)
shape = (1, pipe.unet.config.in_channels, 64, 64)
lat0 = torch.randn(shape, generator=gen)
lat1 = torch.randn(shape, generator=gen)

frames = []
for i in range(num_frames):
    t = i / max(num_frames - 1, 1)
    latents = slerp(t, lat0, lat1).to(device)
    image = pipe(
        prompt=prompt,
        num_inference_steps=2,
        guidance_scale=0.0,
        latents=latents,
    ).images[0]
    frames.append(np.asarray(image))

# Ping-pong so the loop is seamless (forward then back).
frames = frames + frames[-2:0:-1]
imageio.mimsave(out_path, frames, fps=fps, codec="libx264", quality=8)
print(out_path)
