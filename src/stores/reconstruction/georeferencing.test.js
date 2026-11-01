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
