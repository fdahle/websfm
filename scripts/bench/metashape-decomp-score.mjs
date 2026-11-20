// One scorer for camera models from either tool (dev/baselines.md ▸ B-decomp): camera
// centres against the RTK file (with the antenna offset) by a 7-parameter similarity, and
// the GCP checkpoints triangulated from GeoScan's Metashape image marks through the app's own
// path (gcpsInPinholeFrame + triangulateGcp, the −½ mark convention), taken through that
// similarity: exactly what the bench and the Node replays report as positionCheck /
// checkpointCheck. A Metashape model is converted to WebSfM's camera convention first
// (pixel centres at integers, cx = W/2 + cx − ½, p1/p2 exchanged; metashapeXml.js).
//
//   node scripts/bench/metashape-decomp-score.mjs --model <model.json> --config <bench cfg.json> [--out <json>]
//
// model.json: either Metashape's (metashape_decomp.py export: { calibration, cameras:
// { label: 4×4 camera→internal } }) or WebSfM's ({ format: 'websfm', cameras: { stem: { R,
// t, K, dist, selfCal } } }, written by the decomposition's replay).
import { readFile, writeFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { dirname, resolve } from 'node:path'

const repo = resolve(dirname(fileURLToPath(import.meta.url)), '../..')
const stem = (n) =>
  String(n)
    .replace(/\.[^.]+$/, '')
    .toLowerCase()
const r4 = (v) => (v == null ? null : +v.toFixed(4))

let wasmReady = null
async function ensureWasm() {
  if (!wasmReady) {
    wasmReady = (async () => {
      const m = await import(`${repo}/src/wasm/reconstruction/reconstruction.js`)
      await m.default({ module_or_path: await readFile(`${repo}/src/wasm/reconstruction/reconstruction_bg.wasm`) })
    })()
  }
  return wasmReady
}

/** Metashape calibration (its frame model) → WebSfM K and Brown bag (metashapeXml.js). */
export function metashapeLens(c) {
  const W = c.width,
    H = c.height
  if (c.b1 || c.b2 || c.k4) throw new Error('b1/b2/k4 are not in WebSfM’s model: score would be wrong')
  return {
    K: { fx: c.f, fy: c.f, cx: W / 2 + c.cx - 0.5, cy: H / 2 + c.cy - 0.5 },
    dist: { k1: c.k1, k2: c.k2, k3: c.k3, p1: c.p2, p2: c.p1 },
  }
}

/** Metashape model.json → { stem: { R (world→camera rows), t, K, dist, selfCal } } in its internal frame. */
export function metashapeCameras(model) {
  const { K, dist } = metashapeLens(model.calibration)
  const out = {}
  for (const [label, T] of Object.entries(model.cameras)) {
    // T: camera → internal, row-major 4×4; its 3×3 is a rotation (unit scale).
    const Rc = [
      [T[0], T[1], T[2]],
      [T[4], T[5], T[6]],
      [T[8], T[9], T[10]],
    ]
    const C = [T[3], T[7], T[11]]
    const R = [0, 1, 2].map((i) => [Rc[0][i], Rc[1][i], Rc[2][i]])
    const t = R.map((row) => -(row[0] * C[0] + row[1] * C[1] + row[2] * C[2]))
    out[stem(label)] = { R, t, K, dist, selfCal: null }
  }
  return out
}

/**
 * @param {{ [stem]: { R, t, K, dist?, selfCal? } }} cams
 * @param {object} ref  loadReference(cfg.reference)
 */
export async function scoreCameras(cams, ref) {
  await ensureWasm()
  const { cameraPositionCheck, gcpCheck } = await import(`${repo}/src/core/eval/positionCheck.js`)
  const { gcpsInPinholeFrame } = await import(`${repo}/src/core/sfm/displayFrame.js`)
  const { triangulateGcp } = await import(`${repo}/src/core/sfm/gcpTriangulation.js`)
  // A WebSfM camera may carry its rolling-shutter motion (`rs`): a mark is seen from where
  // the camera was at its row (gcpTriangulation.js rowCamera), as the bench scores it.
  const cameras = new Map(
    Object.entries(cams).map(([s, c]) => [s, { R: c.R, t: c.t, K: c.K, ...(c.rs ? { rs: c.rs } : {}) }]),
  )
  const positions = new Map([...cameras.keys()].filter((s) => ref.positions[s]).map((s) => [s, ref.positions[s]]))
  const pc = cameraPositionCheck(cameras, positions, { leverArm: ref.leverArm })
  const imagesById = new Map([...cameras.keys()].map((s) => [s, { uuid: s }]))
  const frameModel = (im) => ({
    dist: cams[im.uuid]?.dist ?? null,
    selfCal: cams[im.uuid]?.selfCal ?? null,
    fiducial: null,
  })
  const gcps = ref.gcps.map((g) => ({
    ...g,
    id: g.label,
    observations: g.marks.filter((m) => cameras.has(m.image)).map((m) => ({ imageId: m.image, px: m.px, py: m.py })),
  }))
  const inFrame = gcpsInPinholeFrame(gcps, { imagesById, sparseCameras: cameras, frameModel })
  const tri = []
  for (const g of inFrame) {
    const t = await triangulateGcp(g.observations, cameras)
    tri.push({ ...g, views: g.observations.length, sfm: t ? [t.x, t.y, t.z] : null })
  }
  const excl = new Set((ref.excludeGcps ?? []).map(String))
  const ck = gcpCheck(
    pc,
    tri.filter((t) => !excl.has(String(t.label))),
  )
  return {
    cameras: cameras.size,
    rms3d: r4(pc.rms3d),
    rmsH: r4(pc.rmsH),
    rmsV: r4(pc.rmsV),
    ckH: r4(ck.rmsH),
    ckV: r4(ck.rmsV),
    ckN: ck.count,
    excluded: [...excl],
    mean: [r4(ck.meanE), r4(ck.meanN), r4(ck.meanU)],
    rows: ck.rows.map((r) => ({ label: r.label, views: r.views, d: [r4(r.dE), r4(r.dN), r4(r.dU)] })),
  }
}

async function main() {
  const args = {}
  for (let i = 2; i < process.argv.length; i += 2) args[process.argv[i].slice(2)] = process.argv[i + 1]
  const { loadReference } = await import(`${repo}/scripts/bench/reference.mjs`)
  const cfg = JSON.parse(await readFile(args.config, 'utf8'))
  const ref = await loadReference(cfg.reference)
  const model = JSON.parse(await readFile(args.model, 'utf8'))
  const cams = model.format === 'websfm' ? model.cameras : metashapeCameras(model)
  const score = await scoreCameras(cams, ref)
  const text = JSON.stringify({ model: args.model, ...score })
  if (args.out) await writeFile(args.out, text + '\n')
  console.log(JSON.stringify({ ...score, rows: undefined }))
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await main()
