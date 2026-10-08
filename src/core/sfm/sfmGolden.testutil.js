// Golden-output runner for sfmGolden.test.js (see there). Kept free of vitest so a
// plain node script can drive the same scenes (timing, heap probes).

import { reconstruct } from './sfm.js'
import { packReconstructionResult } from './resultCodec.js'
import { aerialBlock } from './syntheticScene.testutil.js'

// Scenes are built fresh for every run: reconstruct() mutates its input's pairs
// (refitted F) and the caller's keypoint arrays must not leak between runs.
export const GOLDEN_SCENES = {
  // EXIF-only camera with 4 % focal error and k1/k2: staged self-cal, folds, guided
  // extension, GCP anchoring, weak bridges.
  selfCal: () => aerialBlock({ seed: 7, rows: 4, cols: 6, gcps: 5 }),
  // Calibrated Brown model: ingest undistortion + F refit, self-cal resolved off,
  // camera-prior BA.
  calibrated: () => aerialBlock({ seed: 21, rows: 3, cols: 6, calibrated: true, priors: true, prefix: 'cal' }),
  // Three unconnected 9-image blocks: the primary takes one (a third of the set), so
  // the alternate-seed retries run, then the other two become secondary models (kept
  // separate: they share no cameras).
  stranded: () => aerialBlock({ seed: 33, rows: 3, cols: 3, nPoints: 2000, prefix: 'st',
    blocks: [{ rows: 3, cols: 3, offsetX: 400, offsetY: 0 }, { rows: 3, cols: 3, offsetX: 0, offsetY: 500 }] }),
  // Film scans: per-image scan→canonical fiducial affine at ingest, F refit.
  film: () => aerialBlock({ seed: 45, rows: 3, cols: 4, nPoints: 2000, film: true, prefix: 'fm' }),
}

const DROP_LOG = [/took \d+ms/, /total time \d/, / solver — /]

function digestTyped(arr) {
  return arr ? Array.from(arr, (v) => (Number.isNaN(v) ? 'NaN' : v)) : null
}

// Drop wall-clock fields recursively; everything else must match exactly.
function scrub(value) {
  if (Array.isArray(value)) return value.map(scrub)
  if (value && typeof value === 'object' && !ArrayBuffer.isView(value)) {
    const out = {}
    for (const [k, v] of Object.entries(value)) {
      if (k === 'date' || k === 'timings' || k === 'ms') continue
      out[k] = scrub(v)
    }
    return out
  }
  return value
}

function digestModel(m) {
  const b = m.buffers || {}
  return scrub({
    status: m.status, cameras: m.cameras, summary: m.summary, viewUuids: m.viewUuids,
    pointCount: m.pointCount, hasColor: m.hasColor,
    name: m.name ?? null, componentImageUuids: m.componentImageUuids ?? null, alignment: m.alignment ?? null,
    pos: digestTyped(b.pos && new Float64Array(b.pos)),
    col: digestTyped(b.col && new Uint8Array(b.col)),
    colorMask: digestTyped(b.colorMask && new Uint8Array(b.colorMask)),
    vcount: digestTyped(b.vcount && new Uint32Array(b.vcount)),
    vcam: digestTyped(b.vcam && new Uint32Array(b.vcam)),
    vkp: digestTyped(b.vkp && new Uint32Array(b.vkp)),
    vx: digestTyped(b.vx && new Float32Array(b.vx)),
    vy: digestTyped(b.vy && new Float32Array(b.vy)),
  })
}

export async function runGoldenScene(name, { prepare = (scene) => scene } = {}) {
  const scene = prepare(GOLDEN_SCENES[name]())
  const logs = []
  const out = await reconstruct(
    { images: scene.images, pairs: scene.pairs, gcps: scene.gcps, cameraPriors: scene.cameraPriors, settings: {} },
    { onLog: (m, level, cat) => { if (!DROP_LOG.some((re) => re.test(m))) logs.push(`${level}|${cat}|${m}`) } },
  )
  const { result } = packReconstructionResult(out)
  return {
    model: digestModel(result),
    secondary: (result.secondaryModels || []).map(digestModel),
    logs,
  }
}

// First differing path between two digests, for a readable failure.
export function firstDiff(a, b, path = '') {
  if (Object.is(a, b)) return null
  if (typeof a !== typeof b || a === null || b === null || typeof a !== 'object') {
    return `${path || '<root>'}: ${JSON.stringify(a)?.slice(0, 200)} ≠ ${JSON.stringify(b)?.slice(0, 200)}`
  }
  if (Array.isArray(a) !== Array.isArray(b)) return `${path}: array vs object`
  const keys = new Set([...Object.keys(a), ...Object.keys(b)])
  for (const k of keys) {
    const d = firstDiff(a[k], b[k], `${path}.${k}`)
    if (d) return d
  }
  return null
}

