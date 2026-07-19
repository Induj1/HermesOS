#!/usr/bin/env python3
"""Erase a described object from a photo (text-guided inpainting).

Usage: python inpaint_remove.py <input> <output.png> "<object description>"

CLIPSeg turns the description into a mask; the mask is dilated and Stable
Diffusion inpainting fills the region with plausible background. Models download
once (CLIPSeg ~150MB, SD-inpainting ~2.5GB).
"""
import sys

import numpy as np
import torch
from diffusers import StableDiffusionInpaintPipeline
from PIL import Image, ImageFilter
from transformers import CLIPSegForImageSegmentation, CLIPSegProcessor

in_path, out_path, target = sys.argv[1], sys.argv[2], sys.argv[3]
device = "mps" if torch.backends.mps.is_available() else "cpu"

image = Image.open(in_path).convert("RGB")
W, H = image.size

# 1) Text -> mask with CLIPSeg.
seg_proc = CLIPSegProcessor.from_pretrained("CIDAS/clipseg-rd64-refined")
seg = CLIPSegForImageSegmentation.from_pretrained("CIDAS/clipseg-rd64-refined")
inputs = seg_proc(text=[target], images=[image], return_tensors="pt")
with torch.no_grad():
    logits = seg(**inputs).logits
prob = torch.sigmoid(logits).numpy()
mask = (prob > 0.4).astype(np.uint8) * 255
mask_img = Image.fromarray(mask).resize((W, H)).filter(ImageFilter.MaxFilter(15))

# 2) Inpaint the masked region at 512px, then restore the original size.
pipe = StableDiffusionInpaintPipeline.from_pretrained(
    "runwayml/stable-diffusion-inpainting", torch_dtype=torch.float32
).to(device)
pipe.set_progress_bar_config(disable=True)
work = image.resize((512, 512))
work_mask = mask_img.resize((512, 512))
result = pipe(
    prompt="clean background, seamless, natural, empty",
    image=work,
    mask_image=work_mask,
    num_inference_steps=25,
    guidance_scale=7.5,
).images[0]
result.resize((W, H)).save(out_path)
print(out_path)
