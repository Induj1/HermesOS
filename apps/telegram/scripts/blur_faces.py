#!/usr/bin/env python3
"""Blur every detected face in an image (privacy).

Usage: python blur_faces.py <input> <output.png>
Prints the number of faces blurred. Uses OpenCV's bundled Haar cascade.
"""
import sys

import cv2

in_path = sys.argv[1]
out_path = sys.argv[2]

img = cv2.imread(in_path)
if img is None:
    print("0")
    sys.exit(0)

gray = cv2.cvtColor(img, cv2.COLOR_BGR2GRAY)
cascade = cv2.CascadeClassifier(
    cv2.data.haarcascades + "haarcascade_frontalface_default.xml"
)
faces = cascade.detectMultiScale(gray, scaleFactor=1.1, minNeighbors=5, minSize=(30, 30))

for x, y, w, h in faces:
    roi = img[y : y + h, x : x + w]
    k = max(3, (w // 3) | 1)  # odd kernel, scaled to the face
    img[y : y + h, x : x + w] = cv2.GaussianBlur(roi, (k, k), 0)

cv2.imwrite(out_path, img)
print(str(len(faces)))
