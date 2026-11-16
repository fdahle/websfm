"""Export PaddleOCR's PP-OCRv5 mobile text detector and English recogniser to ONNX.

WebSfM finds and reads the text printed on scanned aerial photographs (frame numbers,
data strips, annotations) with the two PP-OCRv5 mobile models, run in the browser on
ONNX Runtime Web:

  ppocr_det.onnx      x [1,3,H,W] BGR, (v/255 - mean) / std with the ImageNet mean and
                      std per channel in that order, H and W multiples of 32
                      -> probability map [1,1,H,W] of "inside a text line" (DB)
                      (core/ocr/detect.js)
  ppocr_rec_en.onnx   x [N,3,48,W] BGR, v/127.5 - 1, any W
                      -> [N,W/8,438] softmax over blank + 436 characters + space (CTC)
                      (core/ocr/recognize.js)

The networks are PaddlePaddle's official inference models, converted unchanged by
paddle2onnx. The character table of the recogniser is written to
src/core/ocr/dictEn.js. Both models are Apache-2.0 (github.com/PaddlePaddle/PaddleOCR).

Usage (a fresh env: paddlepaddle 3.2, paddle2onnx 2.1, onnx, onnxruntime, pyyaml,
numpy, and tifffile + imagecodecs for --verify on a TIFF scan):

  python -I scripts/models/export-ppocr.py --out public/models --work <scratch dir> \\
      [--verify <image>]

`--verify` runs both graphs, Paddle and ONNX Runtime CPU, on the image (detector) and
on a crop of it (recogniser) and prints the largest difference.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import shutil
import subprocess
import sys
import tarfile
import urllib.request
from pathlib import Path

BASE = "https://paddle-model-ecology.bj.bcebos.com/paddlex/official_inference_model/paddle3.0.0/"
MODELS = {
    # out file: (PaddleX model name, sha256 of its _infer.tar)
    "ppocr_det.onnx": ("PP-OCRv5_mobile_det", "50446e5d01ac2a73d5319c89513281f6578414c888c602f9af13f93feefffc58"),
    "ppocr_rec_en.onnx": ("en_PP-OCRv5_mobile_rec", "e595b4cf2ffad19fbb5a61ba345d63939577a3ab8717b6e5995642590c9101b4"),
}
REPO = Path(__file__).resolve().parents[2]
DICT_JS = REPO / "src/core/ocr/dictEn.js"


def sha256(path: Path) -> str:
    return hashlib.sha256(path.read_bytes()).hexdigest()


def fetch(name: str, want: str, work: Path) -> Path:
    tar = work / f"{name}.tar"
    if not tar.exists() or sha256(tar) != want:
        print(f"download {name}")
        urllib.request.urlretrieve(f"{BASE}{name}_infer.tar", tar)
    got = sha256(tar)
    if got != want:
        sys.exit(f"{tar}: sha256 {got}, expected {want}")
    folder = work / f"{name}_infer"
    if folder.exists():
        shutil.rmtree(folder)
    with tarfile.open(tar) as t:
        t.extractall(work, filter="data")
    return folder


def convert(folder: Path, out: Path) -> None:
    exe = Path(sys.executable).with_name("paddle2onnx")
    subprocess.run([str(exe), "--model_dir", str(folder), "--model_filename", "inference.json",
                    "--params_filename", "inference.pdiparams", "--save_file", str(out),
                    "--opset_version", "14"], check=True)
    print(f"{out.name}: {out.stat().st_size / 1e6:.1f} MB, sha256 {sha256(out)}")


def write_dict(folder: Path) -> None:
    import yaml

    chars = yaml.safe_load((folder / "inference.yml").read_text())["PostProcess"]["character_dict"]
    chars = [str(c) for c in chars]
    assert all(len(c) == 1 for c in chars), "a dictionary entry is not one character"
    DICT_JS.parent.mkdir(parents=True, exist_ok=True)
    DICT_JS.write_text(
        "// The character table of PaddleOCR's en_PP-OCRv5_mobile_rec model (Apache-2.0,\n"
        "// github.com/PaddlePaddle/PaddleOCR), as its inference.yml lists it; written by\n"
        "// scripts/models/export-ppocr.py. Output class 0 is the CTC blank, class i the\n"
        "// entry i - 1, and the last class a space.\n"
        f"export const EN_DICT = {json.dumps(chars, ensure_ascii=False)}\n"
    )
    print(f"{DICT_JS.relative_to(REPO)}: {len(chars)} characters")


def verify(folders: dict[str, Path], out: Path, image: Path) -> None:
    import numpy as np
    import onnxruntime as ort
    import paddle.inference as pi

    if image.suffix.lower() in (".tif", ".tiff"):
        import tifffile

        gray = tifffile.imread(image)
    else:
        import cv2

        gray = cv2.imread(str(image), cv2.IMREAD_GRAYSCALE)
    gray = gray if gray.ndim == 2 else gray[..., 0]
    step = max(1, max(gray.shape) // 960)
    small = gray[::step, ::step][: 32 * (gray.shape[0] // step // 32), : 32 * (gray.shape[1] // step // 32)]
    bgr = np.repeat(small[None].astype(np.float32) / 255, 3, axis=0)
    mean, std = np.array([0.485, 0.456, 0.406])[:, None, None], np.array([0.229, 0.224, 0.225])[:, None, None]
    det_in = ((bgr - mean) / std).astype(np.float32)[None]
    rec_in = (small[None, :48, :320].astype(np.float32) / 127.5 - 1).repeat(3, axis=0)[None]
    for name, x in (("ppocr_det.onnx", det_in), ("ppocr_rec_en.onnx", rec_in)):
        folder = folders[name]
        config = pi.Config(str(folder / "inference.json"), str(folder / "inference.pdiparams"))
        config.disable_gpu()
        predictor = pi.create_predictor(config)
        handle = predictor.get_input_handle(predictor.get_input_names()[0])
        handle.copy_from_cpu(x)
        predictor.run()
        want = predictor.get_output_handle(predictor.get_output_names()[0]).copy_to_cpu()
        got = ort.InferenceSession(str(out / name)).run(None, {"x": x})[0]
        print(f"{name}: output {list(got.shape)}, max |onnx - paddle| = {np.abs(got - want).max():.2e}")


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--out", type=Path, required=True)
    parser.add_argument("--work", type=Path, required=True)
    parser.add_argument("--verify", type=Path)
    args = parser.parse_args()
    args.out.mkdir(parents=True, exist_ok=True)
    args.work.mkdir(parents=True, exist_ok=True)
    folders = {}
    for out_name, (name, want) in MODELS.items():
        folders[out_name] = fetch(name, want, args.work)
        convert(folders[out_name], args.out / out_name)
    write_dict(folders["ppocr_rec_en.onnx"])
    if args.verify:
        verify(folders, args.out, args.verify)


if __name__ == "__main__":
    main()
