"""Build an example dataset for the app's "Try an example" list (src/core/examples.js).

Downscales a set of photos to the detector's default resolution, keeps their EXIF
(GPS, focal length), fixes the EXIF image size to match, optionally writes the
35 mm-equivalent focal length when the camera left it out, and writes the
manifest.json the app reads. The output folder is what the host serves at
<site>/examples/<id>/ (see scripts/fetch-examples.mjs).

Needs Pillow and exiftool:

    python scripts/examples/make-example.py SRC_DIR OUT_DIR \
        [--max-dim 2400] [--first A.JPG --last B.JPG] [--exclude C.JPG ...] [--focal35 25]
        [--credits CREDITS.txt]

The Aukerman example is SRC_DIR = OpenDroneMap/odm_data_aukerman/images (CC0) with
--first DSC00268.JPG --last DSC00311.JPG (the second of the flight's two laps),
--exclude DSC00270.JPG DSC00271.JPG (two corner shots with one weak pair each, which
do not register), --focal35 25 (Sony DSC-WX220: 4.45 mm = 25 mm equivalent, per
Sony's spec sheet) and --credits scripts/examples/aukerman-CREDITS.txt.

Every example carries a CREDITS.txt naming whose photos they are and their licence.
"""
import argparse
import json
import subprocess
from pathlib import Path

from PIL import Image


def main():
    ap = argparse.ArgumentParser(description=__doc__.split('\n')[0])
    ap.add_argument('src', type=Path)
    ap.add_argument('out', type=Path)
    ap.add_argument('--max-dim', type=int, default=2400)
    ap.add_argument('--quality', type=int, default=90)
    ap.add_argument('--first', help='first file name to include (sorted order)')
    ap.add_argument('--last', help='last file name to include (sorted order)')
    ap.add_argument('--exclude', nargs='*', default=[], help='file names to leave out')
    ap.add_argument('--focal35', type=float, help='write FocalLengthIn35mmFormat')
    ap.add_argument('--credits', type=Path, required=True, help='whose photos, and their licence (copied as CREDITS.txt)')
    args = ap.parse_args()

    names = sorted(p.name for p in args.src.iterdir() if p.suffix.lower() in ('.jpg', '.jpeg'))
    if args.first:
        names = [n for n in names if n >= args.first]
    if args.last:
        names = [n for n in names if n <= args.last]
    names = [n for n in names if n not in args.exclude]
    if not names:
        raise SystemExit('no images selected')

    args.out.mkdir(parents=True, exist_ok=True)
    files = []
    for name in names:
        target = args.out / name
        with Image.open(args.src / name) as img:
            exif = img.info.get('exif')
            scale = min(1.0, args.max_dim / max(img.size))
            size = (round(img.width * scale), round(img.height * scale))
            small = img.resize(size, Image.LANCZOS) if scale < 1 else img.copy()
            small.save(target, 'JPEG', quality=args.quality, exif=exif or b'')
        tags = [f'-ExifImageWidth={size[0]}', f'-ExifImageHeight={size[1]}']
        if args.focal35:
            tags.append(f'-FocalLengthIn35mmFormat={args.focal35:g}')
        subprocess.run(['exiftool', '-q', '-overwrite_original', *tags, str(target)], check=True)
        files.append({'name': name, 'bytes': target.stat().st_size})
        print(f'{name}: {size[0]}×{size[1]}, {files[-1]["bytes"] / 1e6:.2f} MB')

    (args.out / 'CREDITS.txt').write_text(args.credits.read_text())
    (args.out / 'manifest.json').write_text(json.dumps({'files': files}, indent=1) + '\n')
    total = sum(f['bytes'] for f in files)
    print(f'{len(files)} images, {total / 1e6:.1f} MB → {args.out}')


if __name__ == '__main__':
    main()
