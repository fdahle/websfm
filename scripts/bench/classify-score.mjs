// Score Classify Points (core/products/pointClasses.js after groundFilter.js) against a
// labelled point cloud: per-class IoU, precision, recall and F1 (dev/planning/
// plan-maturity.md ▸ CL-3). Runs the same code the app runs, in Node.
//
//   node scripts/bench/classify-score.mjs --ply scene.ply [--label class] [--preset stpls3d]
//        [--map '{"0":2,"1":6}'] [--metres-per-unit 1] [--out result.json]
//
// The PLY needs x, y, z (z up), optionally red/green/blue, and an integer label property
// (`--label`, default "class"). `--preset` maps a dataset's labels onto LAS classes; a
// label it does not name counts as "other above ground" (LAS 1). Vegetation is scored per
// band and as one class (3–5 together), since a dataset's bands rarely match ours.
import { readFile, writeFile } from 'node:fs/promises'
import { parsePly } from '../../src/core/io/ply.js'
import { classifyCloudGround } from '../../src/core/products/groundFilter.js'

// STPLS3D (Chen et al. 2022; labels from its README): 0 ground, 1 building, 2/3/4 low /
// medium / high vegetation, 17 windows (building); vehicles, poles, fences, clutter …
// are other (1). Its road, dirt and grass ground materials (15, 18, 19) are ground too.
const PRESETS = {
  stpls3d: { 0: 2, 1: 6, 2: 3, 3: 4, 4: 5, 15: 2, 17: 6, 18: 2, 19: 2 },
}

const args = Object.fromEntries(
  process.argv
    .slice(2)
    .join(' ')
    .split(/\s*--/)
    .filter(Boolean)
    .map((a) => {
      const i = a.indexOf(' ')
      return i < 0 ? [a, true] : [a.slice(0, i), a.slice(i + 1).trim()]
    }),
)
if (!args.ply) throw new Error('--ply <file> is required')
const labelName = args.label ?? 'class'
const map = args.map ? JSON.parse(args.map) : args.preset ? PRESETS[args.preset] : null
if (!map) throw new Error(`--preset (${Object.keys(PRESETS).join(', ')}) or --map is required`)
const metresPerUnit = Number(args['metres-per-unit'] ?? 1)

const buf = await readFile(args.ply)
const cloud = parsePly(buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength))
const labels = cloud.attributes?.[labelName]
if (!labels) throw new Error(`no "${labelName}" property (has: ${Object.keys(cloud.attributes ?? {}).join(', ')})`)
const truth = new Uint8Array(cloud.count)
for (let i = 0; i < cloud.count; i++) truth[i] = map[Math.round(labels[i])] ?? 1

const t0 = performance.now()
const r = classifyCloudGround({ count: cloud.count, pos: cloud.pos, col: cloud.col ?? null }, null, {
  extent: 'all',
  metresPerUnit,
  aboveGround: { vegetation: true, buildings: true },
})
const seconds = (performance.now() - t0) / 1000
const pred = r.classes

// Low points (7) count as ground for scoring: noise under the terrain, not a class here.
const norm = (c) => (c === 7 ? 2 : c === 0 ? 1 : c)
const score = (inTruth, inPred) => {
  let tp = 0,
    fp = 0,
    fn = 0
  for (let i = 0; i < cloud.count; i++) {
    const a = inTruth(truth[i]),
      b = inPred(norm(pred[i]))
    if (a && b) tp++
    else if (b) fp++
    else if (a) fn++
  }
  const precision = tp + fp ? tp / (tp + fp) : null
  const recall = tp + fn ? tp / (tp + fn) : null
  const f1 =
    precision != null && recall != null && precision + recall ? (2 * precision * recall) / (precision + recall) : null
  const iou = tp + fp + fn ? tp / (tp + fp + fn) : null
  return { support: tp + fn, precision, recall, f1, iou }
}
const is =
  (...c) =>
  (v) =>
    c.includes(v)
const classes = {
  ground: score(is(2), is(2)),
  building: score(is(6), is(6)),
  vegetation: score(is(3, 4, 5), is(3, 4, 5)),
  lowVegetation: score(is(3), is(3)),
  mediumVegetation: score(is(4), is(4)),
  highVegetation: score(is(5), is(5)),
  other: score(is(1), is(1)),
}
const scored = Object.values(classes).filter((c) => c.support > 0 && c.iou != null)
const result = {
  file: args.ply,
  points: cloud.count,
  colour: !!cloud.col,
  seconds,
  voxel: r.aboveGround?.voxel ?? null,
  classes,
  meanIou: scored.reduce((a, c) => a + c.iou, 0) / (scored.length || 1),
}
const pct = (v) => (v == null ? '   —  ' : `${(100 * v).toFixed(1).padStart(5)}%`)
console.log(`${cloud.count.toLocaleString()} points, ${seconds.toFixed(1)} s, voxel ${result.voxel} m`)
console.log('class              support   IoU     F1      prec    recall')
for (const [k, c] of Object.entries(classes))
  console.log(
    `${k.padEnd(18)} ${String(c.support).padStart(9)} ${pct(c.iou)} ${pct(c.f1)} ${pct(c.precision)} ${pct(c.recall)}`,
  )
console.log(`mean IoU over classes present: ${pct(result.meanIou)}`)
if (args.out) await writeFile(args.out, JSON.stringify(result, null, 2))
