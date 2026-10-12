// Dense accuracy / completeness against an ETH3D laser-scan ground truth.
//
//   node scripts/bench/eth3d.mjs --scene <ETH3D scene dir> --recon <cloud.dense.bin | fused.ply>
//        [--tolerances 0.01,0.02,0.05,0.1,0.2,0.5] [--label name] [--out result.json]
//
// <scene>/dslr_scan_eval/scan_alignment.mlp places each scan*.ply in the frame of the
// scene's ground-truth cameras (dslr_calibration_undistorted), so a cloud built on those
// cameras (bench stage "colmap" + depth + dense + exportDense, or COLMAP's own dense on
// them) is compared without any alignment. `.dense.bin` is raw Float32 xyz (the bench's
// exportDense); `.ply` goes through the app's own reader (core/io/ply.js).
//
// The metric follows ETH3D's definitions at its tolerances, but it is an APPROXIMATION
// of their evaluator, not a leaderboard number: no occlusion / unobserved-space
// modelling (their tool ignores reconstruction points in space the scanner never saw;
// here a reconstruction point counts only if it lies inside the scans' bounding box,
// grown by the largest tolerance), and both clouds are thinned to one point per
// (smallest tolerance / 2) voxel so dense and sparse regions weigh alike.
//   accuracy(τ)     share of reconstruction points within τ of the ground truth
//   completeness(τ) share of ground-truth points within τ of the reconstruction
//   F1(τ)           their harmonic mean
// Use it to compare runs (websfm vs websfm, websfm vs COLMAP) under one ruler.
import { readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { parsePly } from '../../src/core/io/ply.js'
import { buildKnnIndex, nearestNeighbors } from '../../src/core/products/knn.js'

const args = {}
for (let i = 2; i < process.argv.length; i++) {
  const a = process.argv[i]
  if (a.startsWith('--')) { const v = process.argv[i + 1]; if (v == null || v.startsWith('--')) args[a.slice(2)] = true; else { args[a.slice(2)] = v; i++ } }
}
if (!args.scene || !args.recon) throw new Error('usage: --scene <dir> --recon <file>')
const tolerances = String(args.tolerances ?? '0.01,0.02,0.05,0.1,0.2,0.5').split(',').map(Number)
const voxel = Math.min(...tolerances) / 2

// Thin to one point per voxel (the first one seen). Cells are numeric keys in an
// open-addressing typed-array table, never a JS Map: a Map stops at 2^24 entries, and
// the larger scenes' scans hold ~600 M points (the same trap as the fusion accumulator).
// Keys pack three cell indices offset by 2^16 into one float64-exact number, so a
// scene may span 2^17 cells (650 m at 5 mm) per axis.
function voxelThin(pos, n, cell) {
  const inv = 1 / cell, OFF = 65536, S = 131072
  let size = 1 << 20
  while (size < 2 * Math.min(n, 1 << 28)) size *= 2
  const keys = new Float64Array(size).fill(-1), mask = size - 1
  const out = new Float64Array(3 * Math.min(n, size / 2))
  let m = 0
  for (let i = 0; i < n; i++) {
    const x = pos[3 * i], y = pos[3 * i + 1], z = pos[3 * i + 2]
    if (!Number.isFinite(x + y + z)) continue
    const ix = Math.floor(x * inv) + OFF, iy = Math.floor(y * inv) + OFF, iz = Math.floor(z * inv) + OFF
    if (ix < 0 || iy < 0 || iz < 0 || ix >= S || iy >= S || iz >= S) continue
    const k = (ix * S + iy) * S + iz
    let h = (Math.imul(ix, 0x9e3779b1) ^ Math.imul(iy, 0x85ebca6b) ^ Math.imul(iz, 0xc2b2ae35)) & mask
    while (keys[h] !== -1 && keys[h] !== k) h = (h + 1) & mask
    if (keys[h] === k) continue
    if (m >= out.length / 3) break // table half full: the cap, far above any scene here
    keys[h] = k; out[3 * m] = x; out[3 * m + 1] = y; out[3 * m + 2] = z; m++
  }
  return { count: m, pos: out.subarray(0, 3 * m) }
}

// Ground truth: every scan of the alignment file, transformed into the camera frame.
const evalDir = join(args.scene, 'dslr_scan_eval')
const mlp = await readFile(join(evalDir, 'scan_alignment.mlp'), 'utf8')
const meshes = [...mlp.matchAll(/<MLMesh[^>]*filename="([^"]+)"[^>]*>\s*<MLMatrix44>([\s\S]*?)<\/MLMatrix44>/g)]
  .map((m) => ({ file: m[1], M: m[2].trim().split(/\s+/).map(Number) }))
if (!meshes.length) throw new Error(`no scans in ${join(evalDir, 'scan_alignment.mlp')}`)
const gtParts = []
let gtRaw = 0
for (const { file, M } of meshes) {
  const ply = parsePly(await readFile(join(evalDir, file)))
  const n = ply.count ?? ply.nVerts, p = ply.pos, out = new Float64Array(3 * n)
  for (let i = 0; i < n; i++) {
    const x = p[3 * i], y = p[3 * i + 1], z = p[3 * i + 2]
    out[3 * i] = M[0] * x + M[1] * y + M[2] * z + M[3]
    out[3 * i + 1] = M[4] * x + M[5] * y + M[6] * z + M[7]
    out[3 * i + 2] = M[8] * x + M[9] * y + M[10] * z + M[11]
  }
  gtParts.push(out); gtRaw += n
}
const gtAll = new Float64Array(gtRaw * 3)
{ let o = 0; for (const p of gtParts) { gtAll.set(p, o); o += p.length } }
const gt = voxelThin(gtAll, gtRaw, voxel)

// Reconstruction.
let recPos, recN
if (args.recon.endsWith('.bin')) {
  const b = await readFile(args.recon)
  recPos = new Float32Array(b.buffer, b.byteOffset, Math.floor(b.byteLength / 12) * 3); recN = recPos.length / 3
} else {
  const ply = parsePly(await readFile(args.recon)); recPos = ply.pos; recN = ply.count ?? ply.nVerts
}
const lo = [Infinity, Infinity, Infinity], hi = [-Infinity, -Infinity, -Infinity]
for (let i = 0; i < gt.count; i++) for (let a = 0; a < 3; a++) {
  const v = gt.pos[3 * i + a]; if (v < lo[a]) lo[a] = v; if (v > hi[a]) hi[a] = v
}
const grow = Math.max(...tolerances)
const inBox = new Float64Array(recN * 3)
let nIn = 0
for (let i = 0; i < recN; i++) {
  const x = recPos[3 * i], y = recPos[3 * i + 1], z = recPos[3 * i + 2]
  if (x < lo[0] - grow || x > hi[0] + grow || y < lo[1] - grow || y > hi[1] + grow || z < lo[2] - grow || z > hi[2] + grow) continue
  inBox[3 * nIn] = x; inBox[3 * nIn + 1] = y; inBox[3 * nIn + 2] = z; nIn++
}
const rec = voxelThin(inBox, nIn, voxel)

// Distances both ways (exact k-d tree), then shares per tolerance.
const dRec = nearestNeighbors(buildKnnIndex(gt), rec).dist
const dGt = nearestNeighbors(buildKnnIndex(rec), gt).dist
const share = (d, t) => { let k = 0; for (let i = 0; i < d.length; i++) if (d[i] <= t) k++; return d.length ? k / d.length : 0 }
const rows = tolerances.map((t) => {
  const acc = share(dRec, t), comp = share(dGt, t)
  return { tolerance: t, accuracy: +(100 * acc).toFixed(2), completeness: +(100 * comp).toFixed(2), f1: +(acc + comp > 0 ? 200 * acc * comp / (acc + comp) : 0).toFixed(2) }
})
const out = {
  label: args.label ?? args.recon, scene: args.scene, recon: args.recon,
  groundTruth: { scans: meshes.length, rawPoints: gtRaw, thinnedPoints: gt.count, voxel },
  reconstruction: { points: recN, inScanBox: nIn, thinnedPoints: rec.count },
  metric: 'approximate ETH3D (no occlusion model; scan-box crop)', rows,
}
console.log(`${out.label}: ${rows.map((r) => `${r.tolerance * 100}cm acc ${r.accuracy}% comp ${r.completeness}% F1 ${r.f1}`).join(' | ')}`)
if (args.out) await writeFile(args.out, JSON.stringify(out, null, 2))
