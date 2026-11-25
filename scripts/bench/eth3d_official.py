"""ETH3D's own evaluator (github.com/ETH3D/multi-view-evaluation) on one dense cloud, its
result written in eth3d_score.py's JSON shape, so the scoreboard reads either:

    python eth3d_official.py --scene <ETH3D scene dir> --recon <cloud.dense.bin | .ply>
        [--label x] [--out result.json] [--evaluator <ETH3DMultiViewEvaluation>]

The evaluator is a C++ program built outside the repo: $ETH3D_EVALUATOR, else
/data1/websfm_eval/shared/tools/multi-view-evaluation/build/ETH3DMultiViewEvaluation ($ETH3D_EVALUATOR). To build it
(PCL 1.13, Boost, Eigen; the conda env `eth3d-eval` on the bench machine):

    git clone https://github.com/ETH3D/multi-view-evaluation && cd multi-view-evaluation
    sed -i 's/-std=c++11"/-std=c++17"/' CMakeLists.txt     # PCL 1.13 needs C++14 or later
    mkdir build && cd build && cmake .. -DCMAKE_BUILD_TYPE=Release && make -j

Unlike eth3d_score.py (a reimplementation, about ±4 points off), this is the number ETH3D
publishes: it models the laser's free space from the scans themselves. A WebSfM cloud
(.dense.bin: float32 x, y, z) is written to a temporary PLY first. Needs numpy.
"""
import argparse
import json
import os
import re
import subprocess
import sys
import tempfile
import time

import numpy as np

DEFAULT_EVALUATOR = os.environ.get(
    "ETH3D_EVALUATOR",
    "/data1/websfm_eval/shared/tools/multi-view-evaluation/build/ETH3DMultiViewEvaluation",
)

ap = argparse.ArgumentParser()
ap.add_argument("--scene", required=True)
ap.add_argument("--recon", required=True)
ap.add_argument("--label")
ap.add_argument("--out")
ap.add_argument("--tolerances", default="0.01,0.02,0.05,0.1,0.2,0.5")
ap.add_argument("--evaluator", default=os.environ.get("ETH3D_EVALUATOR", DEFAULT_EVALUATOR))
a = ap.parse_args()

if not os.path.exists(a.evaluator):
    sys.exit(f"ETH3D evaluator not found at {a.evaluator}: build it (see this file's header) or set ETH3D_EVALUATOR")
mlp = os.path.join(a.scene, "dslr_scan_eval", "scan_alignment.mlp")
if not os.path.exists(mlp):
    sys.exit(f"{mlp}: not an ETH3D high-res scene folder")


def write_ply(xyz, path):
    with open(path, "wb") as f:
        f.write(
            f"ply\nformat binary_little_endian 1.0\nelement vertex {len(xyz)}\n"
            "property float x\nproperty float y\nproperty float z\nend_header\n".encode()
        )
        f.write(np.ascontiguousarray(xyz, dtype="<f4").tobytes())


tmp = None
ply = a.recon
points = None
if a.recon.endswith(".bin"):
    xyz = np.fromfile(a.recon, dtype="<f4")
    xyz = xyz[: len(xyz) // 3 * 3].reshape(-1, 3)
    points = len(xyz)
    tmp = tempfile.NamedTemporaryFile(suffix=".ply", delete=False, dir=os.path.dirname(os.path.abspath(a.out or a.recon)))
    tmp.close()
    write_ply(xyz, tmp.name)
    ply = tmp.name
    del xyz

t0 = time.time()
try:
    r = subprocess.run(
        [a.evaluator, "--tolerances", a.tolerances, "--reconstruction_ply_path", ply, "--ground_truth_mlp_path", mlp],
        capture_output=True,
        text=True,
    )
finally:
    if tmp:
        os.unlink(tmp.name)
if r.returncode != 0:
    sys.exit(f"evaluator failed ({r.returncode}): {r.stderr[-1000:]}")

# The evaluator prints one line per measure, its values in --tolerances order:
#   Tolerances: 0.01 0.02 …   Completenesses: 0.43 0.55 …   Accuracies: …   F1-scores: …
def values(name):
    m = re.search(rf"^{name}:\s*(.+)$", r.stdout, re.M)
    if not m:
        sys.exit(f"no '{name}' line in the evaluator's output:\n{r.stdout[-2000:]}")
    return [float(v) for v in m.group(1).split()]


tols, comp, acc, f1 = values("Tolerances"), values("Completenesses"), values("Accuracies"), values("F1-scores")
rows = [
    {"tolerance": t, "accuracy": round(100 * ac, 2), "completeness": round(100 * c, 2), "f1": round(100 * f, 2)}
    for t, c, ac, f in zip(tols, comp, acc, f1)
]
out = {
    "label": a.label or a.recon,
    "scene": a.scene,
    "recon": a.recon,
    "reconstruction": {"points": points},
    "metric": "ETH3D official evaluator (multi-view-evaluation)",
    "evaluator": a.evaluator,
    "seconds": round(time.time() - t0, 1),
    "rows": rows,
}
print(out["label"] + ": " + " | ".join(f"{x['tolerance']*100:g}cm acc {x['accuracy']}% comp {x['completeness']}% F1 {x['f1']}" for x in rows), flush=True)
if a.out:
    json.dump(out, open(a.out, "w"), indent=2)
