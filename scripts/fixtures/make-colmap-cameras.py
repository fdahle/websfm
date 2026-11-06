"""COLMAP's camera models as a reference for WebSfM's lens models.

Writes tests/fixtures/colmap/cameras.json: for each COLMAP model WebSfM has an
equivalent of (OPENCV, FULL_OPENCV, OPENCV_FISHEYE, RADIAL, SIMPLE_RADIAL), a few
parameter sets and random rays in the camera frame, with the pixel COLMAP projects
each ray to (Camera.img_from_cam) and the normalised point it recovers from that pixel
(Camera.cam_from_img). src/core/sfm/colmapCameras.test.js checks distortion.js
against them. Projection has one right answer, so COLMAP is a true oracle here.

    python -m venv venv && venv/bin/pip install pycolmap numpy
    venv/bin/python scripts/fixtures/make-colmap-cameras.py
"""

import json
import math
from pathlib import Path

import numpy as np
import pycolmap

rng = np.random.default_rng(20261104)

# (model, params, the widest ray angle sampled in degrees). The angles stay where each
# lens maps rays to pixels one to one (a strong barrel polynomial folds back further out).
CASES = [
    ("OPENCV", [1200, 1210, 960, 540, -0.12, 0.03, 0.0012, -0.0008], 35),
    ("OPENCV", [800, 800, 640, 480, 0.08, -0.02, -0.002, 0.0015], 35),
    ("FULL_OPENCV", [1500, 1490, 1000, 750, -0.25, 0.08, 0.0005, -0.0003, -0.01, 0.12, -0.02, 0.005], 30),
    ("OPENCV_FISHEYE", [400, 401, 960, 960, 0.05, -0.01, 0.002, -0.0003], 75),
    ("OPENCV_FISHEYE", [600, 600, 1500, 1000, -0.03, 0.004, 0.0, 0.0], 70),
    ("RADIAL", [1000, 640, 480, -0.08, 0.01], 35),
    ("SIMPLE_RADIAL", [900, 512, 384, 0.04], 35),
]

out = {"generator": f"pycolmap {pycolmap.__version__}", "cases": []}
for model, params, max_deg in CASES:
    # The image size does not enter projection.
    cam = pycolmap.Camera(model=model, width=3000, height=2000, params=params)
    n = 40
    theta = np.radians(max_deg) * np.sqrt(rng.random(n))  # uniform over the disc of directions
    phi = 2 * math.pi * rng.random(n)
    rays = np.stack([np.sin(theta) * np.cos(phi), np.sin(theta) * np.sin(phi), np.cos(theta)], axis=1)
    rays *= rng.uniform(1.0, 20.0, size=(n, 1))  # any depth: projection divides it out
    pixels = cam.img_from_cam(rays)
    back = cam.cam_from_img(pixels)
    out["cases"].append(
        {
            "model": model,
            "paramNames": [s.strip() for s in cam.params_info.split(",")],
            "params": params,
            "rays": rays.tolist(),
            "pixels": np.asarray(pixels).tolist(),
            "normalized": np.asarray(back).tolist(),
        }
    )

path = Path(__file__).resolve().parents[2] / "tests/fixtures/colmap/cameras.json"
path.parent.mkdir(parents=True, exist_ok=True)
path.write_text(json.dumps(out, indent=1) + "\n")
print(f"{path}: {len(out['cases'])} cases")
