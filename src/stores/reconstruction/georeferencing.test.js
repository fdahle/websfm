import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { beforeAll, it, expect, vi } from 'vitest'
import { ref, effectScope } from 'vue'
import initRecon from '../../wasm/reconstruction/reconstruction.js'
import { createGeoreferencing } from './georeferencing.js'
import { applySimilarity } from '../../core/products/georef.js'
import { projectPoint } from '../../core/sfm/geometry.js'

// The accuracy report triangulates in the WASM module: hand init() its bytes.
beforeAll(async () => {
  const url = new URL('../../wasm/reconstruction/reconstruction_bg.wasm', import.meta.url)
  await initRecon({ module_or_path: await readFile(fileURLToPath(url)) })
})
const R = [
  [1, 0, 0],
  [0, 1, 0],
  [0, 0, 1],
]

// A GCP the fit can use: control with X, Y, Z, accuracies and two marks.
const usableControl = {
  id: 'control',
  role: 'control',
  x: 1,
  y: 2,
  z: 3,
  accuracyX: 0.02,
  accuracyY: 0.02,
  accuracyZ: 0.05,
  observations: [
    { imageId: 'a', px: 10, py: 10 },
    { imageId: 'b', px: 20, py: 20 },
  ],
}

function poseFit() {
  const scope = effectScope()
  const controls = ref([])
  const georef = ref(null)
  const log = vi.fn()
  const R0 = R
  const api = scope.run(() =>
    createGeoreferencing({
      sparseCameras: ref(
        new Map([
          ['a', { R: R0, t: [0, 0, 0] }],
          ['b', { R: R0, t: [-1, 0, 0] }],
          ['c', { R: R0, t: [0, -1, 0] }],
        ]),
      ),
      images: ref(['a', 'b', 'c'].map((id) => ({ id, uuid: id }))),
      georef,
      healthDirty: ref(0),
      poses: () => [
        { imageId: 'a', x: 0, y: 0, z: 0 },
        { imageId: 'b', x: 2, y: 0, z: 0 },
        { imageId: 'c', x: 0, y: 2, z: 0 },
      ],
      gcps: () => controls.value,
      currentCrs: () => 'EPSG:3031',
      modelStamp: () => 'first',
      save: vi.fn(),
      log,
    }),
  )
  return { scope, controls, georef, log, api }
}

it('keeps a fitted georeference while the GCPs it could use stay the same', async () => {
  const { scope, controls, georef, log, api } = poseFit()
  await api.georeference()
  expect(georef.value).not.toBeNull()
  // Added with no coordinates, then given them, marked once, renamed: still nothing
  // the fit could use, so the georeference (and the products built in it) stays.
  controls.value.push({ id: 'new', name: 'GCP 2', role: 'control', x: null, y: null, z: null, observations: [] })
  Object.assign(controls.value[0], { x: 5, y: 6, z: 7, accuracyX: 0.02, accuracyY: 0.02, accuracyZ: 0.05 })
  controls.value[0].observations.push({ imageId: 'a', px: 1, py: 1 })
  controls.value[0].name = 'North pillar'
  // A checkpoint marked twice is measured against the fit, not part of it.
  controls.value.push({ ...usableControl, id: 'check', role: 'check' })
  expect(georef.value).not.toBeNull()
  expect(api.validGeoref.value).not.toBeNull()
  expect(log.mock.calls.some(([m]) => m.startsWith('Georeference dropped,'))).toBe(false)
  // Its second mark makes it usable: now the fit is out of date.
  controls.value[0].observations.push({ imageId: 'b', px: 2, py: 2 })
  expect(georef.value).toBeNull()
  scope.stop()
})

it.each(['pose', 'control', 'model', 'camera', 'stale fit'])(
  'invalidates a fitted georeference after %s evidence changes',
  async (field) => {
    const scope = effectScope()
    const controls = ref([]),
      model = ref('first')
    const poses = ref([
      { imageId: 'a', x: 0, y: 0, z: 0 },
      { imageId: 'b', x: 2, y: 0, z: 0 },
      { imageId: 'c', x: 0, y: 2, z: 0 },
    ])
    const cameras = ref(
      new Map([
        ['a', { R, t: [0, 0, 0] }],
        ['b', { R, t: [-1, 0, 0] }],
        ['c', { R, t: [0, -1, 0] }],
      ]),
    )
    const georef = ref(null)
    const log = vi.fn()
    const api = scope.run(() =>
      createGeoreferencing({
        sparseCameras: cameras,
        images: ref(['a', 'b', 'c'].map((id) => ({ id, uuid: id }))),
        georef,
        healthDirty: ref(0),
        poses: () => poses.value,
        gcps: () => controls.value,
        currentCrs: () => 'EPSG:3031',
        modelStamp: () => model.value,
        save: vi.fn(),
        log,
      }),
    )
    // Grid scale 2 at the pole of EPSG:3031, where the point scale factor is
    // k ≈ 0.97277: fitted in the local metric frame the similarity's scale is the
    // GROUND scale 2/k, and the frame travels with it.
    const fitted = await api.georeference()
    expect(fitted.sim.local.k).toBeCloseTo(0.97277, 4)
    expect(fitted.sim.scale).toBeCloseTo(2 / fitted.sim.local.k, 6)
    expect(api.validGeoref.value).not.toBeNull()
    if (field === 'pose') poses.value[1].x = 10
    if (field === 'control') controls.value.push(usableControl)
    if (field === 'model') model.value = 'replacement'
    if (field === 'camera') cameras.value.get('b').t[0] = -2
    // A fit for other evidence put in place (an older one restored), the evidence unchanged.
    if (field === 'stale fit') georef.value = { ...fitted, evidenceKey: 'other evidence' }
    expect(georef.value).toBeNull()
    // The log says why: what changed, and at info only for a rebuilt model.
    const [message, level] = log.mock.calls.find(([m]) => m.startsWith('Georeference dropped,'))
    const why = {
      'pose': 'the camera positions (1 edited)',
      'control': 'the GCPs (1 added)',
      'model': 'the sparse model',
      'camera': 'the cameras (1 edited)',
      'stale fit': 'the saved evidence',
    }[field]
    expect(message).toContain(`since it was fitted: ${why}.`)
    expect(level).toBe(field === 'model' ? 'info' : 'warn')
    expect(api.poseResidualReport()).toEqual([])
    scope.stop()
  },
)

it('names why a geographic project cannot be georeferenced and suggests a projected CRS', async () => {
  const scope = effectScope()
  const crs = ref('EPSG:4326')
  // EXIF positions in a geographic project CRS: x = lon, y = lat (St Nazaire, zone 31N).
  const poses = ref([
    { imageId: 'a', x: 5.2755, y: 44.5688, z: 518 },
    { imageId: 'b', x: 5.276, y: 44.569, z: 519 },
    { imageId: 'c', x: 5.2765, y: 44.5692, z: 520 },
  ])
  const cameras = ref(
    new Map([
      ['a', { R, t: [0, 0, 0] }],
      ['b', { R, t: [-1, 0, 0] }],
      ['c', { R, t: [0, -1, 0] }],
    ]),
  )
  const log = vi.fn()
  const api = scope.run(() =>
    createGeoreferencing({
      sparseCameras: cameras,
      images: ref(['a', 'b', 'c'].map((id) => ({ id, uuid: id }))),
      georef: ref(null),
      healthDirty: ref(0),
      poses: () => poses.value,
      gcps: () => [],
      currentCrs: () => crs.value,
      save: vi.fn(),
      log,
    }),
  )
  expect(api.canGeoreference.value).toBe(false)
  expect(api.georeferenceBlocker.value).toBe('geographic')
  expect(api.crsSuggestion.value).toMatchObject({ code: 'EPSG:32631', count: 3 })
  expect(await api.georeference()).toBeNull()
  expect(log.mock.calls.at(-1)[0]).toContain('EPSG:32631')

  // A projected CRS with the same three cameras can be fitted; nothing is suggested.
  crs.value = 'EPSG:3031'
  expect(api.georeferenceBlocker.value).toBeNull()
  expect(api.crsSuggestion.value).toBeNull()
  // …and with too few positions the blocker is the evidence, not the CRS.
  poses.value = poses.value.slice(0, 2)
  expect(api.georeferenceBlocker.value).toBe('evidence')
  scope.stop()
})

it("falls back to the images' EXIF GPS when no positions are materialised yet", () => {
  const scope = effectScope()
  const api = scope.run(() =>
    createGeoreferencing({
      sparseCameras: ref(new Map()),
      images: ref([{ id: 'a', uuid: 'a', meta: { gpsLat: -33.9, gpsLon: 18.4 } }]),
      georef: ref(null),
      healthDirty: ref(0),
      poses: () => [],
      gcps: () => [],
      currentCrs: () => 'EPSG:4326',
      save: vi.fn(),
      log: vi.fn(),
    }),
  )
  expect(api.crsSuggestion.value.code).toBe('EPSG:32734')
  scope.stop()
})

it('records the vertical datum the control shares, and unknown when it is mixed', async () => {
  const fit = async (datums) => {
    const scope = effectScope()
    const poses = ref(
      [
        { imageId: 'a', x: 0, y: 0, z: 0 },
        { imageId: 'b', x: 2, y: 0, z: 0 },
        { imageId: 'c', x: 0, y: 2, z: 0 },
      ].map((p, i) => ({ ...p, verticalDatum: datums[i] })),
    )
    const api = scope.run(() =>
      createGeoreferencing({
        sparseCameras: ref(
          new Map([
            ['a', { R, t: [0, 0, 0] }],
            ['b', { R, t: [-1, 0, 0] }],
            ['c', { R, t: [0, -1, 0] }],
          ]),
        ),
        images: ref(['a', 'b', 'c'].map((id) => ({ id, uuid: id }))),
        georef: ref(null),
        healthDirty: ref(0),
        poses: () => poses.value,
        gcps: () => [],
        currentCrs: () => 'EPSG:3031',
        modelStamp: () => 'm',
        save: vi.fn(),
        log: vi.fn(),
      }),
    )
    const g = await api.georeference()
    scope.stop()
    return g.verticalDatum
  }
  expect(await fit(['ellipsoidal', 'ellipsoidal', 'ellipsoidal'])).toBe('ellipsoidal')
  expect(await fit(['ellipsoidal', 'geoid:EGM96', 'ellipsoidal'])).toBe('unknown')
  expect(await fit([undefined, undefined, undefined])).toBe('unknown')
})

it('moves the georeference by a co-registration, keeps it through a refit, and removes it', async () => {
  const scope = effectScope()
  const poses = ref([
    { imageId: 'a', x: 1000, y: 2000, z: 0 },
    { imageId: 'b', x: 1002, y: 2000, z: 0 },
    { imageId: 'c', x: 1000, y: 2002, z: 0 },
  ])
  const cameras = ref(
    new Map([
      ['a', { R, t: [0, 0, 0] }],
      ['b', { R, t: [-1, 0, 0] }],
      ['c', { R, t: [0, -1, 0] }],
    ]),
  )
  const georef = ref(null),
    coregistration = ref(null)
  const log = vi.fn()
  const api = scope.run(() =>
    createGeoreferencing({
      sparseCameras: cameras,
      images: ref(['a', 'b', 'c'].map((id) => ({ id, uuid: id }))),
      georef,
      coregistration,
      healthDirty: ref(0),
      poses: () => poses.value,
      gcps: () => [],
      currentCrs: () => 'EPSG:3031',
      modelStamp: () => 'model',
      save: vi.fn(),
      log,
    }),
  )
  const { applySimilarity } = await import('../../core/products/georef.js')
  const at = (p) => applySimilarity(georef.value.sim, p)
  await api.georeference()
  const before = at([0, 0, 0])
  // The DEM sat 10 m west, 5 m north and 1 m low of the reference: move it by (+10, −5, +1).
  const from = [
    [1000, 2000, 0],
    [1002, 2000, 0],
    [1000, 2002, 0],
    [1002, 2002, 1],
  ]
  const pairs = { from, to: from.map(([x, y, z]) => [x + 10, y - 5, z + 1]) }
  api.setCoregistration({ reference: 'rema', crs: 'EPSG:3031', pairs, move: [10, -5, 1], tilt: false })
  expect(georef.value.coregistered).toBe(true)
  const moved = at([0, 0, 0])
  expect(moved[0] - before[0]).toBeCloseTo(10, 3)
  expect(moved[1] - before[1]).toBeCloseTo(-5, 3)
  expect(moved[2] - before[2]).toBeCloseTo(1, 3)
  // A refit (new evidence) composes it again.
  poses.value = poses.value.map((p) => ({ ...p }))
  await api.georeference()
  expect(at([0, 0, 0])[0] - before[0]).toBeCloseTo(10, 3)
  expect(log.mock.calls.some(([m]) => /co-registered to "rema"/.test(m))).toBe(true)
  // A co-registration in another CRS than the fit's does not apply.
  api.setCoregistration({ reference: 'rema', crs: 'EPSG:32633', pairs, move: [10, -5, 1], tilt: false })
  expect(georef.value.coregistered).toBeUndefined()
  api.setCoregistration(null)
  expect(at([0, 0, 0])[0]).toBeCloseTo(before[0], 6)
  expect(georef.value.fitSim).toBeUndefined()
  scope.stop()
})

// F13: a model held to a reference DEM by its camera positions is placed in the frame
// the solve held it in, not refitted to the cameras (which would put it back on their
// heights); a frame held in another CRS is not used.
it('places a DEM-held model in its held frame, not a refit to the cameras', async () => {
  const scope = effectScope()
  const crs = ref('EPSG:3031')
  const held = ref(null)
  const georef = ref(null)
  const cameras = ref(
    new Map([
      ['a', { R, t: [0, 0, 0] }],
      ['b', { R, t: [-1, 0, 0] }],
      ['c', { R, t: [0, -1, 0] }],
    ]),
  )
  const api = scope.run(() =>
    createGeoreferencing({
      sparseCameras: cameras,
      images: ref(['a', 'b', 'c'].map((id) => ({ id, uuid: id }))),
      georef,
      healthDirty: ref(0),
      poses: () => [
        { imageId: 'a', x: 0, y: 0, z: 0 },
        { imageId: 'b', x: 2, y: 0, z: 0 },
        { imageId: 'c', x: 0, y: 2, z: 0 },
      ],
      gcps: () => [],
      currentCrs: () => crs.value,
      heldFrame: () => held.value,
      save: vi.fn(),
      log: vi.fn(),
    }),
  )
  const fitted = await api.georeference()
  expect(fitted.method).toBe('poses')
  // The solve lowered the block 0.5 onto the DEM: its frame is the pose fit moved down.
  held.value = {
    sim: { ...fitted.sim, t: [fitted.sim.t[0], fitted.sim.t[1], fitted.sim.t[2] - 0.5] },
    crs: 'EPSG:3031',
    verticalDatum: 'ellipsoidal',
  }
  georef.value = null
  const placed = await api.georeference()
  expect(placed.method).toBe('dem-hold')
  expect(placed.sim.t[2]).toBeCloseTo(fitted.sim.t[2] - 0.5, 9)
  expect(placed.verticalDatum).toBe('ellipsoidal')
  expect(placed.rms).toBeCloseTo(0.5, 6)
  // Held in another CRS: the cameras place it again.
  held.value = { ...held.value, crs: 'EPSG:3413' }
  georef.value = null
  expect((await api.georeference()).method).toBe('poses')
  scope.stop()
})

it('keeps a restored georeference while the project is still restoring, then checks it', async () => {
  // The stores restore concurrently: the model and its georeference may arrive before
  // the poses they were fitted on. Judged then, every reopen dropped the fit.
  const scope = effectScope()
  const full = [
    { imageId: 'a', x: 0, y: 0, z: 0 },
    { imageId: 'b', x: 2, y: 0, z: 0 },
    { imageId: 'c', x: 0, y: 2, z: 0 },
  ]
  const poses = ref(structuredClone(full))
  const cameras = ref(
    new Map([
      ['a', { R, t: [0, 0, 0] }],
      ['b', { R, t: [-1, 0, 0] }],
      ['c', { R, t: [0, -1, 0] }],
    ]),
  )
  const georef = ref(null),
    restoring = ref(false)
  const api = scope.run(() =>
    createGeoreferencing({
      sparseCameras: cameras,
      images: ref(['a', 'b', 'c'].map((id) => ({ id, uuid: id }))),
      georef,
      healthDirty: ref(0),
      poses: () => poses.value,
      gcps: () => [],
      currentCrs: () => 'EPSG:3031',
      save: vi.fn(),
      log: vi.fn(),
      restoring,
    }),
  )
  const fitted = { ...(await api.georeference()) }

  // Reopen: the georeference lands while the poses are not in yet.
  restoring.value = true
  poses.value = []
  georef.value = fitted
  expect(georef.value).not.toBeNull()
  poses.value = structuredClone(full)
  restoring.value = false
  expect(georef.value).not.toBeNull()
  expect(api.validGeoref.value).not.toBeNull()

  // A fit that really is stale still goes, once the restore is whole.
  restoring.value = true
  georef.value = { ...fitted, evidenceKey: 'other evidence' }
  expect(georef.value).not.toBeNull()
  restoring.value = false
  expect(georef.value).toBeNull()
  scope.stop()
})

it('places a block flown with a GNSS lever arm by its antenna positions', async () => {
  // Lawnmower nadir block, strips flown in alternate directions (yaw 0° / 180°), in a
  // metre CRS; the SfM frame is the CRS shrunk 10× about an offset. The poses are the
  // ANTENNA positions, C + Rᵀ·a with a = (0.10, 0.05, −0.30) m in camera axes.
  const off = [500000, 5400000, 0]
  const arm = [0.1, 0.05, -0.3]
  const nadir = [
    [1, 0, 0],
    [0, -1, 0],
    [0, 0, -1],
  ]
  const back = [
    [-1, 0, 0],
    [0, 1, 0],
    [0, 0, -1],
  ]
  const cams = new Map(),
    poses = [],
    images = []
  for (let strip = 0; strip < 4; strip++)
    for (let k = 0; k < 6; k++) {
      const id = `s${strip}k${k}`
      const Rw = strip % 2 ? back : nadir
      const C = [off[0] + 40 * k + 3 * strip, off[1] + 30 * strip, 120 + (k % 3)]
      const Cs = C.map((v, i) => (v - off[i]) / 10)
      const t = [0, 1, 2].map((i) => -(Rw[i][0] * Cs[0] + Rw[i][1] * Cs[1] + Rw[i][2] * Cs[2]))
      cams.set(id, { R: Rw, t })
      const ant = [0, 1, 2].map((i) => C[i] + Rw[0][i] * arm[0] + Rw[1][i] * arm[1] + Rw[2][i] * arm[2])
      poses.push({ imageId: id, x: ant[0], y: ant[1], z: ant[2] })
      images.push({ id, uuid: id, sensorId: 'drone' })
    }
  const georef = ref(null)
  const scope = effectScope()
  const api = scope.run(() =>
    createGeoreferencing({
      sparseCameras: ref(cams),
      images: ref(images),
      georef,
      healthDirty: ref(0),
      poses: () => poses,
      gcps: () => [],
      currentCrs: () => 'local',
      save: vi.fn(),
      log: vi.fn(),
      leverArms: () => (imageId) => (images.some((im) => im.id === imageId) ? arm : null),
    }),
  )
  const fitted = await api.georeference()
  expect(fitted.method).toBe('poses')
  const { applySimilarity } = await import('../../core/products/georef.js')
  // A ground point maps to its true CRS position (without the arm: 0.30 m high).
  const G = [off[0] + 100, off[1] + 45, 12.5]
  const q = applySimilarity(
    fitted.sim,
    G.map((v, i) => (v - off[i]) / 10),
  )
  for (let i = 0; i < 3; i++) expect(Math.abs(q[i] - G[i])).toBeLessThan(1e-3)
  // Pose residuals show no ± pattern from the arm.
  const rows = api.poseResidualReport()
  expect(rows).toHaveLength(24)
  for (const r of rows) expect(r.dTotal).toBeLessThan(1e-3)
  scope.stop()
})

it.each([
  ['object', null],
  ['aerial', 0.5],
])('a single strip placed by its positions: %s project', async (sceneType, maxRollDeg) => {
  // 20 nadir cameras along east, GPS σ 1.5 m. An object project cannot tell the roll
  // about the line and refuses; an aerial one fixes it from the photos looking down.
  for (const start of [3, 11, 29, 47, 83]) await stripCase(sceneType, maxRollDeg, start)
})

async function stripCase(sceneType, maxRollDeg, start) {
  let seed = start
  const rnd = () => ((seed = (seed * 1664525 + 1013904223) >>> 0), seed / 2 ** 32)
  const gauss = () => Math.sqrt(-2 * Math.log(rnd() + 1e-12)) * Math.cos(2 * Math.PI * rnd())
  const nadir = [
    [1, 0, 0],
    [0, -1, 0],
    [0, 0, -1],
  ]
  const cams = new Map(),
    poses = [],
    images = []
  for (let i = 0; i < 20; i++) {
    const id = `c${i}`
    const Cs = [i * 5 + 0.002 * gauss(), 0.002 * gauss(), 12 + 0.002 * gauss()] // SfM = truth / 10
    cams.set(id, {
      R: nadir,
      t: [0, 1, 2].map((r) => -(nadir[r][0] * Cs[0] + nadir[r][1] * Cs[1] + nadir[r][2] * Cs[2])),
    })
    poses.push({
      imageId: id,
      x: 50 * i + 1.5 * gauss(),
      y: 1.5 * gauss(),
      z: 120 + 1.5 * gauss(),
      accuracyX: 1.5,
      accuracyY: 1.5,
      accuracyZ: 1.5,
    })
    images.push({ id, uuid: id })
  }
  const log = vi.fn()
  const scope = effectScope()
  const api = scope.run(() =>
    createGeoreferencing({
      sparseCameras: ref(cams),
      images: ref(images),
      georef: ref(null),
      healthDirty: ref(0),
      poses: () => poses,
      gcps: () => [],
      currentCrs: () => 'local',
      save: vi.fn(),
      log,
      sceneType: () => sceneType,
    }),
  )
  const fitted = await api.georeference()
  if (maxRollDeg == null) {
    expect(fitted).toBeNull()
    expect(log.mock.calls.some(([m]) => /lie along one line/.test(m))).toBe(true)
  } else {
    // SfM up (z) maps to the survey's up within the bound.
    const up = [fitted.sim.R[0][2], fitted.sim.R[1][2], fitted.sim.R[2][2]]
    expect((Math.acos(up[2]) * 180) / Math.PI).toBeLessThan(maxRollDeg)
  }
  scope.stop()
}

it('reports where the georeferenced model puts a point without coordinates', async () => {
  const K = { fx: 1000, fy: 1000, cx: 500, cy: 400 }
  // Looking along +Z from C = (0,0,0), (1,0,0), (0,1,0): t = −C.
  const cams = new Map([
    ['a', { R, t: [0, 0, 0], K }],
    ['b', { R, t: [-1, 0, 0], K }],
    ['c', { R, t: [0, -1, 0], K }],
  ])
  const X = [0.3, 0.2, 5]
  const mark = (id) => {
    const p = projectPoint(cams.get(id), ...X)
    return { imageId: id, px: p.u, py: p.v }
  }
  const scope = effectScope()
  const controls = ref([{ id: 'p', name: 'GCP 1', role: 'control', x: null, y: null, z: null, observations: [] }])
  const georef = ref(null)
  const api = scope.run(() =>
    createGeoreferencing({
      sparseCameras: ref(cams),
      images: ref(['a', 'b', 'c'].map((id) => ({ id, uuid: id }))),
      georef,
      healthDirty: ref(0),
      poses: () => [
        { imageId: 'a', x: 0, y: 0, z: 0 },
        { imageId: 'b', x: 2, y: 0, z: 0 },
        { imageId: 'c', x: 0, y: 2, z: 0 },
      ],
      gcps: () => controls.value,
      currentCrs: () => 'EPSG:3031',
      modelStamp: () => 'm',
      save: vi.fn(),
      log: vi.fn(),
    }),
  )
  // Not marked yet: nothing to estimate.
  expect((await api.gcpAccuracyReport())[0].estimate).toBeNull()
  await api.georeference()
  controls.value[0].observations = [mark('a'), mark('b'), mark('c')]
  const [row] = await api.gcpAccuracyReport()
  const want = applySimilarity(georef.value.sim, X)
  for (let i = 0; i < 3; i++) expect(row.estimate[i]).toBeCloseTo(want[i], 6)
  // No coordinates: no residual, only the estimate.
  expect(row.dTotal).toBeNull()
  scope.stop()
})

it('records the accuracy after each fit, once per change, with the value before in the log', async () => {
  const K = { fx: 1000, fy: 1000, cx: 500, cy: 400 }
  const cams = new Map([
    ['a', { R, t: [0, 0, 0], K }],
    ['b', { R, t: [-1, 0, 0], K }],
    ['c', { R, t: [0, -1, 0], K }],
  ])
  const mark = (X) =>
    ['a', 'b', 'c'].map((id) => {
      const p = projectPoint(cams.get(id), ...X)
      return { imageId: id, px: p.u, py: p.v }
    })
  // Model points and where the survey puts them: a similarity of scale 2, shifted.
  const toCrs = ([x, y, z]) => [1000 + 2 * x, 2000 + 2 * y, 2 * z]
  const point = (id, role, X, err = [0, 0, 0]) => {
    const [x, y, z] = toCrs(X)
    return {
      id,
      name: id,
      role,
      x: x + err[0],
      y: y + err[1],
      z: z + err[2],
      accuracyX: 0.01,
      accuracyY: 0.01,
      accuracyZ: 0.01,
      observations: mark(X),
    }
  }
  const controls = ref([
    point('A', 'control', [0.3, 0.2, 5]),
    point('B', 'control', [-0.4, 0.1, 6]),
    point('C', 'control', [0.1, -0.5, 5.5]),
    point('K', 'check', [-0.2, -0.3, 4.5], [0.03, 0, 0.04]),
  ])
  const scope = effectScope()
  const accuracyHistory = ref([])
  const lastModelChange = ref('Optimize cameras: refined the full lens')
  const log = vi.fn()
  const api = scope.run(() =>
    createGeoreferencing({
      sparseCameras: ref(cams),
      images: ref(['a', 'b', 'c'].map((id) => ({ id, uuid: id }))),
      georef: ref(null),
      healthDirty: ref(0),
      poses: () => [],
      gcps: () => controls.value,
      currentCrs: () => 'EPSG:32632',
      modelStamp: () => 'm',
      save: vi.fn(),
      log,
      accuracyHistory,
      lastModelChange,
    }),
  )
  const settle = () => vi.waitFor(() => expect(log.mock.calls.some(([m]) => m.startsWith('Accuracy after'))).toBe(true))
  await api.georeference()
  await settle()
  expect(accuracyHistory.value).toHaveLength(1)
  const first = accuracyHistory.value[0]
  expect(first).toMatchObject({ method: 'gcps', change: 'Optimize cameras: refined the full lens', independent: true })
  expect(first.checkpoints.n).toBe(1)
  // Close to the error put on it; the UTM fit's local metric frame moves it by millimetres.
  expect(first.checkpoints.h).toBeCloseTo(0.03, 2)
  expect(first.checkpoints.v).toBeCloseTo(0.04, 2)
  expect(lastModelChange.value).toBeNull()
  // A refit that changed nothing adds nothing.
  log.mockClear()
  await api.georeference()
  await new Promise((r) => setTimeout(r, 50))
  expect(accuracyHistory.value).toHaveLength(1)
  // The checkpoint surveyed again, closer: a new entry, and the log says what it was.
  controls.value[3] = point('K', 'check', [-0.2, -0.3, 4.5], [0.01, 0, 0.01])
  await api.georeference()
  await settle()
  expect(accuracyHistory.value).toHaveLength(2)
  const line = log.mock.calls.find(([m]) => m.startsWith('Accuracy after'))
  expect(line[0]).toMatch(/^Accuracy after the fit: checkpoints \(1\) H [\d.]+ \/ V [\d.]+ m, was [\d.]+ \/ [\d.]+ m$/)
  const [a, b] = accuracyHistory.value
  expect(b.checkpoints.h).toBeLessThan(a.checkpoints.h)
  expect(b.checkpoints.v).toBeLessThan(a.checkpoints.v)
  expect(line[1]).toBe('info')
  scope.stop()
})
