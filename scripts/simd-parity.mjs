// Runs the built wasm SIFT (simd128 kernels) on the same fixed input as the crate's
// `parity_digest` test and prints the same digest. Native `cargo test` compiles the
// scalar fallbacks (x86 has no simd128 target-feature), so the f32x4 blur kernels are
// otherwise never executed by any test. Compare the two digests by hand.
//
//   cargo test --release -- --ignored --nocapture parity_digest
//   node scripts/simd-parity.mjs
import { readFile } from 'node:fs/promises';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { dirname, join } from 'node:path';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
// pathToFileURL: a bare Windows path is not a legal ESM specifier.
const mod = await import(pathToFileURL(join(root, 'src/wasm/detection/sift.js')).href);
const { default: init, detect_sift } = mod;

await init({ module_or_path: await readFile(join(root, 'src/wasm/detection/sift_bg.wasm')) });

const STRIDE = 133;
const w = 157, h = 113;

// Byte-identical twin of the crate's `parity_image`.
const blobs = [
  [20, 18, 3], [48, 30, 5], [95, 22, 8], [130, 60, 12],
  [35, 80, 6], [75, 95, 4], [120, 100, 9],
];
const rgba = new Uint8Array(w * h * 4);
for (let y = 0; y < h; y++) {
  for (let x = 0; x < w; x++) {
    const i = (y * w + x) * 4;
    let v = 40 + ((x * 3 + y * 5 + ((x * y) % 17) * 2) % 24);
    for (const [cx, cy, r] of blobs) {
      const dx = x - cx, dy = y - cy;
      if (dx * dx + dy * dy < r * r) v += 170;
    }
    v = Math.min(v, 255);
    rgba[i] = v;
    rgba[i + 1] = (v * 3 + x) % 256;
    rgba[i + 2] = (v * 5 + y) % 256;
    rgba[i + 3] = 255;
  }
}

const out = detect_sift(rgba, w, h, 0.02, 1000);
const n = out.length - 2;
const kept = n / STRIDE;

let sx = 0, sy = 0, sd = 0;
for (let k = 0; k < kept; k++) {
  sx += out[k * STRIDE];
  sy += out[k * STRIDE + 1];
  for (let d = 5; d < STRIDE; d++) sd += out[k * STRIDE + d];
}

console.log(
  `\n  DIGEST kept=${kept} raw=${out[n]} sup=${out[n + 1]} ` +
  `sumX=${sx.toFixed(4)} sumY=${sy.toFixed(4)} sumDesc=${sd.toFixed(4)}\n`
);
