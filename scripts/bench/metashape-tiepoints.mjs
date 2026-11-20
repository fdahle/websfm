// Metashape's tie points as a WebSfM SfM input (dev/baselines.md ▸ B-decomp): keypoints and
// pairwise matches from Metashape's valid tracks, everything else (images, sensors, camera
// priors, settings) from a WebSfM `.sfminput` of the same photos, so a replay runs WebSfM's
// whole sparse step (registration, self-calibration, filters) on Metashape's points.
//
//   node scripts/bench/metashape-tiepoints.mjs --tie <dir> --template <puti.sfminput> --out <file.sfminput>
//        [--detect-scale 1] [--min-matches 15] [--noise-px 0] [--keep-tracks 1] [--seed 1]
//
// <dir>: metashape_decomp.py export (tiepoints.bin, tiepoints-cameras.json). Each photo's
// keypoints are its tie point projections (Metashape's pixel edges → WebSfM's pixel centres,
// −½), with Metashape's key point size as the scale; no descriptors (guided extension is
// skipped). Every two photos that share at least `--min-matches` tracks become a pair, its
// matches the shared tracks, its F a robust 8-point fit to them (fundamental.js), in the
// x_bᵀ F x_a convention the template's pairs use (checked on the template's largest pair).
import { readFile, writeFile } from 'node:fs/promises'
import { decodeSfmInput, encodeSfmInput } from '../../tests/bench/sfmInputDump.js'
import { fitFundamental, sampsonRmsPx } from '../../src/core/sfm/fundamental.js'

const args = {}
for (let i = 2; i < process.argv.length; i += 2) args[process.argv[i].slice(2)] = process.argv[i + 1]
const detectScale = Number(args['detect-scale'] ?? 1)
const minMatches = Number(args['min-matches'] ?? 15)
const stem = (n) => n.replace(/\.[^.]+$/, '').toLowerCase()

const tpl = decodeSfmInput(await readFile(args.template))
// The template's F convention: its stored F on its own matches.
{
  const p = [...tpl.pairs].sort((a, b) => b.matches.length - a.matches.length)[0]
  const A = tpl.images.find((i) => i.uuid === p.idA).keypoints,
    B = tpl.images.find((i) => i.uuid === p.idB).keypoints
  const pa = [],
    pb = []
  for (let k = 0; k < p.matches.length; k += 2) {
    pa.push(A[p.matches[k]])
    pb.push(B[p.matches[k + 1]])
  }
  const asStored = sampsonRmsPx(p.F, pa, pb)
  const refit = fitFundamental(pa, pb)
  console.log(
    `template F check: stored ${asStored.toFixed(3)} px, refit ${refit.rmsPx.toFixed(3)} px (${pa.length} matches)`,
  )
  if (!(asStored < 3 * Math.max(refit.rmsPx, 0.5))) throw new Error('template F is not in the x_bᵀ F x_a convention')
}

const labels = JSON.parse(await readFile(`${args.tie}/tiepoints-cameras.json`, 'utf8'))
const buf = await readFile(`${args.tie}/tiepoints.bin`)
const dv = new DataView(buf.buffer, buf.byteOffset, buf.byteLength)
const nc = dv.getInt32(0, true),
  np = dv.getInt32(4, true),
  npr = dv.getInt32(8, true)
let o = 12 + 28 * np
// Degraded variants (which property of the tie points matters): `--noise-px` adds Gaussian
// noise of that σ per axis to every projection, `--keep-tracks` keeps that random share of
// the tracks (both seeded, so a variant is reproducible).
const noisePx = Number(args['noise-px'] ?? 0)
const keepTracks = Number(args['keep-tracks'] ?? 1)
let seed = Number(args.seed ?? 1) >>> 0
const rand = () => {
  seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0
  return (seed + 0.5) / 4294967296
}
const gauss = () => Math.sqrt(-2 * Math.log(rand())) * Math.cos(2 * Math.PI * rand())
const dropTrack = new Map()
const kps = Array.from({ length: nc }, () => [])
const tracks = new Map() // track id → [[cam, kpIdx]]
for (let k = 0; k < npr; k++) {
  const ci = dv.getInt32(o, true),
    tr = dv.getInt32(o + 4, true)
  let x = dv.getFloat32(o + 8, true),
    y = dv.getFloat32(o + 12, true)
  const s = dv.getFloat32(o + 16, true)
  o += 20
  if (keepTracks < 1) {
    if (!dropTrack.has(tr)) dropTrack.set(tr, rand() >= keepTracks)
    if (dropTrack.get(tr)) continue
  }
  if (noisePx > 0) {
    x += noisePx * gauss()
    y += noisePx * gauss()
  }
  const idx = kps[ci].length
  kps[ci].push({ x: x - 0.5, y: y - 0.5, scale: s })
  if (!tracks.has(tr)) tracks.set(tr, [])
  tracks.get(tr).push([ci, idx])
}
const imByStem = new Map(tpl.images.map((im) => [stem(im.name), im]))
const images = labels.map((l, ci) => {
  const im = imByStem.get(stem(l))
  if (!im) throw new Error(`${l} is not in the template`)
  const { descU8: _d, keypoints: _k, ...rest } = im
  return { ...rest, detectScale, keypoints: kps[ci] }
})
const pairMap = new Map()
for (const views of tracks.values()) {
  if (views.length < 2) continue
  views.sort((a, b) => a[0] - b[0])
  for (let i = 0; i < views.length; i++)
    for (let j = i + 1; j < views.length; j++) {
      const key = views[i][0] * 100000 + views[j][0]
      if (!pairMap.has(key)) pairMap.set(key, [])
      pairMap.get(key).push(views[i][1], views[j][1])
    }
}
const pairs = []
let dropped = 0,
  matchTotal = 0
for (const [key, m] of pairMap) {
  const a = Math.floor(key / 100000),
    b = key % 100000
  if (m.length / 2 < minMatches) {
    dropped++
    continue
  }
  const pa = [],
    pb = []
  for (let k = 0; k < m.length; k += 2) {
    pa.push(kps[a][m[k]])
    pb.push(kps[b][m[k + 1]])
  }
  const fit = fitFundamental(pa, pb)
  if (!fit) {
    dropped++
    continue
  }
  pairs.push({
    idA: images[a].uuid,
    idB: images[b].uuid,
    F: fit.F,
    inlierCount: m.length / 2,
    weak: false,
    status: 'done',
    matches: Uint32Array.from(m),
  })
  matchTotal += m.length / 2
}
const out = encodeSfmInput({ images, pairs, gcps: tpl.gcps, cameraPriors: tpl.cameraPriors, settings: tpl.settings })
await writeFile(args.out, out)
console.log(
  JSON.stringify({
    images: images.length,
    keypoints: kps.reduce((s, k) => s + k.length, 0),
    tracks: tracks.size,
    pairs: pairs.length,
    droppedPairs: dropped,
    matches: matchTotal,
    bytes: out.length,
  }),
)
