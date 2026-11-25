// Strecha's multi-view sets (fountain-P11, Herz-Jesu-P8/P25, castle-P19/P30, entry-P10) as
// reference cameras for camera-check.mjs: one COLMAP images.txt per scene.
//
//   node scripts/bench/prep/strecha-prep.mjs <root> [<out>]
//
// <root> holds openMVG's copy (github.com/openMVG/SfM_quality_evaluation,
// Benchmarking_Camera_Calibration_2008/<scene>/{images,gt_dense_cameras}); <out> defaults to
// <root>/websfm. Data: C. Strecha, W. von Hansen, L. Van Gool, P. Fua, U. Thoennessen, "On
// Benchmarking Camera Calibration and Multi-View Stereo for High Resolution Imagery", CVPR 2008.
//
// A .camera file is K (3 rows), the distortion (one row, zero here), a rotation R (3 rows), the
// camera centre C, then width and height. images.txt wants world-to-camera: R_w = Rᵀ,
// t = −Rᵀ C, so camera-check's centre −R_wᵀ t gives C back whatever R's convention.
import { mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

const [, , root, outArg] = process.argv
if (!root) throw new Error('usage: strecha-prep.mjs <root> [<out>]')
const base = join(root, 'Benchmarking_Camera_Calibration_2008')
const out = outArg ?? join(root, 'websfm')

// Shepperd's method: the unit quaternion (w, x, y, z) of a rotation matrix.
function quat(M) {
  const [[a, b, c], [d, e, f], [g, h, i]] = M
  const tr = a + e + i
  if (tr > 0) {
    const s = 2 * Math.sqrt(1 + tr)
    return [s / 4, (h - f) / s, (c - g) / s, (d - b) / s]
  }
  if (a > e && a > i) {
    const s = 2 * Math.sqrt(1 + a - e - i)
    return [(h - f) / s, s / 4, (b + d) / s, (c + g) / s]
  }
  if (e > i) {
    const s = 2 * Math.sqrt(1 + e - a - i)
    return [(c - g) / s, (b + d) / s, s / 4, (f + h) / s]
  }
  const s = 2 * Math.sqrt(1 + i - a - e)
  return [(d - b) / s, (c + g) / s, (f + h) / s, s / 4]
}

for (const scene of readdirSync(base).sort()) {
  const camDir = join(base, scene, 'gt_dense_cameras')
  // Each image's POINTS2D line holds one point with no 3D point (-1): camera-check pairs
  // non-empty lines, so an empty one would shift every camera after it.
  const lines = ['# IMAGE_ID QW QX QY QZ TX TY TZ CAMERA_ID NAME', '# POINTS2D (one placeholder)']
  let id = 0
  for (const f of readdirSync(camDir)
    .filter((n) => n.endsWith('.camera'))
    .sort()) {
    const v = readFileSync(join(camDir, f), 'utf8').trim().split(/\s+/).map(Number)
    const R = [v.slice(12, 15), v.slice(15, 18), v.slice(18, 21)]
    const C = v.slice(21, 24)
    const Rw = [0, 1, 2].map((r) => [0, 1, 2].map((c) => R[c][r]))
    const t = Rw.map((row) => -(row[0] * C[0] + row[1] * C[1] + row[2] * C[2]))
    const q = quat(Rw)
    const name = f.replace(/\.camera$/, '')
    lines.push(`${++id} ${[...q, ...t].map((x) => x.toPrecision(12)).join(' ')} 1 ${name}`, '0 0 -1')
  }
  mkdirSync(join(out, scene), { recursive: true })
  writeFileSync(join(out, scene, 'images.txt'), lines.join('\n') + '\n')
  console.log(`${scene}: ${id} cameras → ${join(out, scene, 'images.txt')}`)
}
