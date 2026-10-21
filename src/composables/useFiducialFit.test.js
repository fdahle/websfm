import { describe, it, expect } from 'vitest'
import { ref, nextTick } from 'vue'
import {
  fitFiducialObservations,
  fiducialResiduals,
  fiducialMarkPositions,
  fiducialGhosts,
  useFiducialFit,
} from './useFiducialFit.js'

// An 8-mark film layout (4 corners + 4 edge midpoints, mm, y up) and a scan where
// 1 mm = 100 px around a principal point at (1000, 1000) px, y down.
const MARKS = [
  { id: 'TL', xMm: -5, yMm: 5 },
  { id: 'TR', xMm: 5, yMm: 5 },
  { id: 'BL', xMm: -5, yMm: -5 },
  { id: 'BR', xMm: 5, yMm: -5 },
  { id: 'T', xMm: 0, yMm: 5 },
  { id: 'B', xMm: 0, yMm: -5 },
  { id: 'L', xMm: -5, yMm: 0 },
  { id: 'R', xMm: 5, yMm: 0 },
]
const scan = (m) => ({ fidId: m.id, px: 1000 + 100 * m.xMm, py: 1000 - 100 * m.yMm })
const byId = (id) => MARKS.find((m) => m.id === id)

describe('fitFiducialObservations', () => {
  it('needs 3 joined marks for the affine; observations of unknown marks are dropped', () => {
    const two = [scan(byId('TL')), scan(byId('TR')), { fidId: 'nope', px: 1, py: 2 }]
    const r = fitFiducialObservations(two, MARKS, 'affine')
    expect(r.obs.map((o) => o.fidId)).toEqual(['TL', 'TR'])
    expect(r.fit).toBeNull()
  })

  it('fits exact observations with ~0 residual per mark', () => {
    const obs = ['TL', 'TR', 'BL', 'BR'].map((id) => scan(byId(id)))
    const r = fitFiducialObservations(obs, MARKS, 'affine')
    expect(r.fit).not.toBeNull()
    const res = fiducialResiduals(r)
    expect([...res.keys()]).toEqual(['TL', 'TR', 'BL', 'BR'])
    for (const um of res.values()) expect(um).toBeLessThan(1e-6)
  })

  it('no fit → no residuals', () => {
    expect(fiducialResiduals({ obs: [{ fidId: 'a' }], fit: null }).size).toBe(0)
  })
})

describe('fiducialMarkPositions', () => {
  it('labels corners, edge midpoints and the centre relative to the layout centroid', () => {
    const pos = fiducialMarkPositions([...MARKS, { id: 'C', xMm: 0, yMm: 0 }, { id: 'bad', xMm: NaN, yMm: 0 }])
    expect(Object.fromEntries(pos)).toEqual({
      TL: 'top-left',
      TR: 'top-right',
      BL: 'bottom-left',
      BR: 'bottom-right',
      T: 'mid-top',
      B: 'mid-bottom',
      L: 'mid-left',
      R: 'mid-right',
      C: 'center',
    })
    expect(fiducialMarkPositions([]).size).toBe(0)
  })
})

describe('fiducialGhosts', () => {
  it('predicts the scan position of every mark not placed yet', () => {
    const obs = ['TL', 'TR', 'BL'].map((id) => scan(byId(id)))
    const { fit } = fitFiducialObservations(obs, MARKS, 'affine')
    const ghosts = fiducialGhosts(fit, MARKS, new Set(['TL', 'TR', 'BL']))
    expect(ghosts.map((g) => g.id)).toEqual(['BR', 'T', 'B', 'L', 'R'])
    const br = ghosts[0]
    expect(br.px).toBeCloseTo(1500, 6)
    expect(br.py).toBeCloseTo(1500, 6)
    expect(fiducialGhosts(null, MARKS, new Set())).toEqual([])
  })
})

describe('useFiducialFit', () => {
  it('is empty unless the sensor is film and something is placed', async () => {
    const isFilm = ref(false)
    const obs = ref(['TL', 'TR', 'BL'].map((id) => scan(byId(id))))
    const f = useFiducialFit({
      isFilm: () => isFilm.value,
      marks: () => MARKS,
      obs: () => obs.value,
      transform: () => '',
    })
    expect(f.fidResidual.value.size).toBe(0)
    expect(f.fidGhosts.value).toEqual([])
    expect([...f.markedFidIds.value]).toEqual(['TL', 'TR', 'BL']) // the menu ✓ shows regardless
    isFilm.value = true
    await nextTick()
    expect(f.fidResidual.value.size).toBe(3)
    expect(f.fidGhosts.value).toHaveLength(5)
    expect(f.fidMarkPos.value.get('TL')).toBe('top-left')
  })
})

describe('fiducialResiduals with an incomplete observation', () => {
  it('keys each residual to its own mark when one observation has no position', () => {
    const marks = [
      { id: 'F1', xMm: 0, yMm: 0 },
      { id: 'F2', xMm: 10, yMm: 0 },
      { id: 'F3', xMm: 0, yMm: 10 },
      { id: 'F4', xMm: 10, yMm: 10 },
    ]
    // F2 has no pixel yet; F4 is off by one pixel, so only F4's residual is large.
    const obs = [
      { fidId: 'F1', px: 100, py: 100 },
      { fidId: 'F2', px: null, py: null },
      { fidId: 'F3', px: 100, py: 200 },
      { fidId: 'F4', px: 201, py: 200 },
    ]
    const res = fiducialResiduals(fitFiducialObservations(obs, marks))
    expect(res.has('F2')).toBe(false)
    expect([...res.keys()].sort()).toEqual(['F1', 'F3', 'F4'])
  })
})
