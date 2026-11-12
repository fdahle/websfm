import { it, expect, vi } from 'vitest'
import { ref, effectScope } from 'vue'
import { createGeoreferencing } from './georeferencing.js'
const R = [
  [1, 0, 0],
  [0, 1, 0],
  [0, 0, 1],
]

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
        log: vi.fn(),
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
    if (field === 'control') controls.value.push({ id: 'control', x: 1, y: 2, z: 3 })
    if (field === 'model') model.value = 'replacement'
    if (field === 'camera') cameras.value.get('b').t[0] = -2
    // A fit for other evidence put in place (an older one restored), the evidence unchanged.
    if (field === 'stale fit') georef.value = { ...fitted, evidenceKey: 'other evidence' }
    expect(georef.value).toBeNull()
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
