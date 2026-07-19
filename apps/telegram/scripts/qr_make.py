#!/usr/bin/env python3
"""Generate a QR code PNG from text.

Usage: python qr_make.py "<text or url>" <out.png>
"""
import sys

import qrcode

text = sys.argv[1]
out_path = sys.argv[2]

img = qrcode.make(text)
img.save(out_path)
print(out_path)
