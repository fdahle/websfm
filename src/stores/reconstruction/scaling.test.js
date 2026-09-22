import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { beforeAll, describe, it, expect } from 'vitest'
import { ref, computed } from 'vue'

import initRecon from '../../wasm/reconstruction/reconstruction.js'
import { createScaling } from './scaling.js'

beforeAll(async () => {
  const wasmUrl = new URL('../../wasm/reconstruction/reconstruction_bg.wasm', import.meta.url)
  await initRecon({ module_or_path: await readFile(fileURLToPath(wasmUrl)) })
})

const I3 = [[1, 0, 0], [0, 1, 0], [0, 0, 1]]
const K = { fx: 1000, fy: 1000, cx: 500, cy: 400 }

// Four cameras along +X at model-unit spacing, all looking down +Z. Centres are
// C = −Rᵀt = −t, so t = −C.
const cam = (cx) => ({ R: I3, t: [-cx, 0, 0], K })
const CAMS = new Map([
  ['uA', cam(0)], ['uB', cam(1)], ['uC', cam(0.3)], ['uD', cam(0.6)],
])
const IMAGES = [
  { id: 'iA', uuid: 'uA', name: 'A.jpg' }, { id: 'iB', uuid: 'uB', name: 'B.jpg' },
  { id: 'iC', uuid: 'uC', name: 'C.jpg' }, { id: 'iD', uuid: 'uD', name: 'D.jpg' },
]

// Project a world point into a camera, so a marker's marks are exactly consistent.
function mark(imageId, uuid, P) {
  const c = CAMS.get(uuid)
  const x = P[0] + c.t[0], y = P[1] + c.t[1], z = P[2] + c.t[2]
  return { imageId, px: K.fx * x / z + K.cx, py: K.fy * y / z + K.cy }
}
function marker(id, name, P) {
  return {
    id, name, role: 'marker', enabled: true, x: null, y: null, z: null,
    accuracyImgX: 1, accuracyImgY: 1,
    observations: IMAGES.map((im) => ({ ...mark(im.id, im.uuid, P), imageName: im.name })),
  }
}

// Two markers 2 model units apart in Z-facing world space.
const M1 = marker('m1', 'M1', [0, 0, 10])
const M2 = marker('m2', 'M2', [2, 0, 10])

function harness({ bars = [], gcps = [M1, M2], cloud = { id: 'c1', createdAt: 't0' } } = {}) {
  const logs = []
  const scaleFit = ref(null)
  const s = createScaling({
    sparseCameras: computed(() => CAMS),
    images: ref(IMAGES),
    mainSparseCloud: computed(() => cloud),
    scaleFit,
    healthDirty: ref(0),
    bars: () => bars,
    gcps: () => gcps,
    persist: () => {},
    log: (m, level) => logs.push([level, m]),
  })
  return { ...s, scaleFit, logs }
}

const bar = (over) => ({
  id: 'b1', name: 'Bar 1', a: { kind: 'marker', id: 'm1' }, b: { kind: 'marker', id: 'm2' },
  knownDistanceM: 0.5, accuracyM: null, displayUnit: 'm', enabled: true, ...over,
})

describe('createScaling · measuring', () => {
  it('measures a marker-to-marker bar in model units', async () => {
    const h = harness({ bars: [bar()] })
    const [m] = await h.measureBars()
    expect(m.reason).toBeNull()
    expect(m.modelDistance).toBeCloseTo(2, 4)
  })

  it('measures a camera-to-camera bar from the camera centres', async () => {
    const h = harness({
      bars: [bar({ a: { kind: 'camera', id: 'iA' }, b: { kind: 'camera', id: 'iB' }, knownDistanceM: 3 })],
    })
    const [m] = await h.measureBars()
    expect(m.modelDistance).toBeCloseTo(1, 9)   // centres 0 and 1 apart
  })

  it('reports WHY an unmeasurable bar cannot be measured, and keeps the row', async () => {
    const h = harness({ bars: [
      bar({ id: 'x1', b: null }),
      bar({ id: 'x2', b: { kind: 'marker', id: 'm1' } }),        // same endpoint twice
      bar({ id: 'x3', knownDistanceM: 0 }),
      bar({ id: 'x4', b: { kind: 'camera', id: 'gone' } }),
    ] })
    const rows = await h.measureBars()
    expect(rows).toHaveLength(4)                                  // nothing dropped
    expect(rows.map((r) => r.reason)).toEqual([
      'endpoint missing', 'both endpoints are the same point',
      'distance must be > 0', 'image removed',
    ])
  })

  it('refuses an endpoint that no longer has marker role', async () => {
    const noLongerMarker = { ...M1, role: 'control' }
    const h = harness({ bars: [bar()], gcps: [noLongerMarker, M2] })
    const [row] = await h.measureBars()
    expect(row.modelDistance).toBeNull()
    expect(row.reason).toContain('no longer a marker')
  })

  it('refuses a disabled marker endpoint', async () => {
    const disabled = { ...M2, enabled: false }
    const h = harness({ bars: [bar()], gcps: [M1, disabled] })
    const [row] = await h.measureBars()
    expect(row.modelDistance).toBeNull()
    expect(row.reason).toContain('disabled')
  })
})

describe('createScaling · the fit', () => {
  it('fits the scale that makes the bar its entered length', async () => {
    const h = harness({ bars: [bar({ knownDistanceM: 0.5 })] })
    const fit = await h.fitScaleBars()
    expect(fit.scale).toBeCloseTo(0.25, 4)      // 2 model units = 0.5 m
    expect(fit.count).toBe(1)
    expect(fit.method).toBe('scalebars')
    expect(fit.rms).toBeCloseTo(0, 6)
  })

  it('logs the fit WITH its inputs', async () => {
    const h = harness({ bars: [bar({ knownDistanceM: 0.5 })] })
    await h.fitScaleBars()
    const line = h.logs.find(([, m]) => m.startsWith('Scale: 1 bar'))[1]
    expect(line).toContain('m per model unit')
    expect(line).toContain('"Bar 1"')
    expect(line).toContain('= 0.5 m')
    expect(line).toContain('equal weight')
  })

  it('excludes a disabled bar from the fit but still reports its residual', async () => {
    const bars = [
      bar({ id: 'on', knownDistanceM: 0.5 }),
      bar({ id: 'off', knownDistanceM: 1.0, enabled: false }),
    ]
    const h = harness({ bars })
    const fit = await h.fitScaleBars()
    expect(fit.count).toBe(1)                                        // only the enabled one
    const rows = await h.scaleBarReport(fit.scale)
    expect(rows).toHaveLength(2)
    const off = rows.find((r) => r.id === 'off')
    expect(off.enabled).toBe(false)
    expect(off.residualM).toBeCloseTo(0.5 - 1.0, 6)                  // 2 u × 0.25 = 0.5 m
  })

  it('reports both residuals when two bars disagree, dropping neither', async () => {
    const bars = [
      bar({ id: 'b1', knownDistanceM: 1.00 }),
      bar({ id: 'b2', a: { kind: 'camera', id: 'iA' }, b: { kind: 'camera', id: 'iB' },
        knownDistanceM: 0.51 }),   // 1 model unit; disagrees ~2 % with 2 u = 1.00 m
    ]
    const h = harness({ bars })
    const fit = await h.fitScaleBars()
    expect(fit.count).toBe(2)
    expect(fit.constraints.map((c) => c.id).sort()).toEqual(['b1', 'b2'])
    expect(fit.rms).toBeGreaterThan(0)
    const rows = await h.scaleBarReport(fit.scale)
    for (const r of rows) expect(r.residualM).not.toBeNull()
  })

  it('reports residuals against a scale the bars did NOT define (the georef case)', async () => {
    const h = harness({ bars: [bar({ knownDistanceM: 0.5 })] })
    // 0.3 m per model unit from some other source ⇒ 2 u reads as 0.6 m.
    const [row] = await h.scaleBarReport(0.3)
    expect(row.measuredM).toBeCloseTo(0.6, 6)
    expect(row.residualM).toBeCloseTo(0.1, 6)
  })

  it('names equal weighting rather than implying a surveyed σ', async () => {
    const h = harness({ bars: [bar({ accuracyM: null }), bar({ id: 'b2', accuracyM: 0.002 })] })
    const rows = await h.scaleBarReport(0.25)
    expect(rows[0].weighting).toBe('equal weight')
    expect(rows[0].normalizedResidual).toBeNull()
    expect(rows[1].weighting).toBe('inverse-variance')
  })
})

describe('createScaling · staleness (D11)', () => {
  it('accepts a fit whose model and evidence are unchanged', async () => {
    const h = harness({ bars: [bar()] })
    await h.fitScaleBars()
    expect(h.scaleFitStatus()).toEqual({ valid: true, reason: null })
  })

  it('rejects a fit after the model is rebuilt (same id, new createdAt)', async () => {
    const cloud = { id: 'c1', createdAt: 't0' }
    const h = harness({ bars: [bar()], cloud })
    await h.fitScaleBars()
    // upsertSparseCloud carries the id forward on a rebuild but refreshes createdAt,
    // so createdAt is the half that actually detects a re-run.
    cloud.createdAt = 't1'
    expect(h.scaleFitStatus()).toEqual({ valid: false, reason: 'model rebuilt' })
  })

  it('rejects a fit after a bar distance is edited', async () => {
    const bars = [bar()]
    const h = harness({ bars })
    await h.fitScaleBars()
    bars[0].knownDistanceM = 0.51
    expect(h.scaleFitStatus().reason).toBe('measurements changed')
  })

  it('rejects a fit after a referenced marker observation moves', async () => {
    const moved = { ...M1, observations: M1.observations.map((o) => ({ ...o })) }
    const h = harness({ bars: [bar()], gcps: [moved, M2] })
    await h.fitScaleBars()
    moved.observations[0].px += 3
    expect(h.scaleFitStatus().reason).toBe('measurements changed')
  })

  it('rejects an unstamped legacy fit rather than trusting it', () => {
    const h = harness({ bars: [bar()] })
    h.scaleFit.value = { scale: 2, rms: 0, count: 1 }
    expect(h.scaleFitStatus()).toEqual({ valid: false, reason: 'unstamped' })
  })

  it('has no fit at all before one is applied', () => {
    expect(harness().scaleFitStatus()).toEqual({ valid: false, reason: 'none' })
  })
})
