#!/usr/bin/env python3
"""Decode QR code(s) in an image and print the contents.

Usage: python qr_read.py <image>
Prints each decoded payload on its own line (empty output = none found).
"""
import sys

import cv2

img = cv2.imread(sys.argv[1])
if img is None:
    sys.exit(0)

detector = cv2.QRCodeDetector()
ok, decoded, _points, _straight = detector.detectAndDecodeMulti(img)
if ok:
    for text in decoded:
        if text:
            print(text)
