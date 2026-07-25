import { describe, it, expect } from 'vitest'

import { registerImages } from './register.js'

// WS-A — the stalled-model rescue must fire at the 2-camera seed, not only from 3
// cameras up. The field failure it exists for (an uncalibrated wide lens: the seed pair
// absorbs radial distortion, every third-view PnP misses the acceptance ratios, and the
// in-registration self-cal that would fix it never engages because the model never
// grows) ends at *exactly* 2 cameras, so a `>= 3` guard could never reach it.
//
// Driven through a mocked ctx rather than a synthetic scene: the sweep is made to
// register nothing while a linked image remains, which is precisely the rescue's
// trigger condition, and no PnP/triangulation is reached (correspondences stay below
// minMatchesForRegistration, matches are empty), so no wasm is needed and the branch
// under test is the only thing exercised.
function makeCtx(overrides = {}) {
  const imgs = [
    { uuid: 'a', name: 'a', keypoints: [], meta: { width: 100, height: 100 } },
    { uuid: 'b', name: 'b', keypoints: [], meta: { width: 100, height: 100 } },
    // Linked to the model (inlierCount > 0) but supplies no usable correspondences,
    // so every sweep defers it → the model stalls at the seed pair.
    { uuid: 'c', name: 'c', keypoints: [], meta: { width: 100, height: 100 } },
  ]
  const K = { fx: 100, fy: 100, cx: 50, cy: 50 }
  const cameras = new Map([
    ['a', { R: [[1, 0, 0], [0, 1, 0], [0, 0, 1]], t: [0, 0, 0], K }],
    ['b', { R: [[1, 0, 0], [0, 1, 0], [0, 0, 1]], t: [1, 0, 0], K }],
  ])
  const donePairs = [
    { idA: 'a', idB: 'b', matches: [], inlierCount: 200 },
    { idA: 'a', idB: 'c', matches: [], inlierCount: 200 },
  ]
  const logs = []
  const baCalls = []
  return {
    logs, baCalls,
    ctx: {
      imgs, donePairs, cameras,
      Kmap: new Map(imgs.map((i) => [i.uuid, K])),
      viewIndex: new Map(),
      registeredUuids: new Set(['a', 'b']),
      getPoints3d: () => [],
      cfg: {
        minMatchesForRegistration: 12, reprjThreshold: 4, pnpGateScale: 2,
        minPnpInliers: 15, minPnpInlierRatio: 0.3, minPnpRefineInlierRatio: 0.3,
        filterMaxReprojPx: 4, filterMinTriAngleDeg: 1.5,
        baIterations: 25, interimBaEvery: 5, interimBaIterations: 12,
        rescueStalled: true, rescueRefineRatio: 0.2, refineIntrinsics: 'f,k1',
        ...overrides,
      },
      addView: () => {},
      rebuildViewIndex: () => {},
      foldOneEndpointMatches: () => 0,
      mergeTracks: () => 0,
      runBundleAdjust: async (label, iters, mode) => { baCalls.push({ label, iters, mode }) },
      filterTracks: () => ({ obsRemoved: 0, ptsRemoved: 0 }),
      modelReprojStats: () => ({ p95: 1, median: 0.5, mean: 0.5 }),
      imageByUuid: (u) => imgs.find((i) => i.uuid === u),
      numStats: () => ({ mean: 0, median: 0 }),
      log: (m, level, cat) => logs.push([level, cat, m]),
    },
  }
}

describe('registerImages — stalled-model rescue (WS-A)', () => {
  it('fires the rescue when the model stalls at the 2-camera seed', async () => {
    const { ctx, logs } = makeCtx()
    await registerImages(ctx)
    expect(logs.some(([, , m]) => /registration stalled at 2 camera\(s\)/.test(m))).toBe(true)
    expect(logs.some(([, , m]) => /rescue retriangulation/.test(m))).toBe(true)
  })

  it('skips the intrinsics solve at 2 cameras — f/k1 are not observable from 2 views', async () => {
    // The self-limiting half of the change: a 2-camera rescue is retriangulation + one
    // relaxed sweep only. If this ever starts calling BA, the rescue is fitting a focal
    // to a 2-view model, which is exactly what the >= 3 inner guard exists to prevent.
    const { ctx, logs, baCalls } = makeCtx()
    await registerImages(ctx)
    expect(baCalls).toHaveLength(0)
    expect(logs.some(([, , m]) => /intrinsics not solvable at 2 views/.test(m))).toBe(true)
  })

  it('stays one-shot: a still-stalled model does not rescue twice', async () => {
    const { ctx, logs } = makeCtx()
    await registerImages(ctx)
    expect(logs.filter(([, , m]) => /rescue retriangulation/.test(m))).toHaveLength(1)
  })

  it('does not rescue when rescueStalled is off', async () => {
    const { ctx, logs } = makeCtx({ rescueStalled: false })
    await registerImages(ctx)
    expect(logs.some(([, , m]) => /registration stalled/.test(m))).toBe(false)
  })

  it('does not rescue a model with no linked unregistered images', async () => {
    const { ctx, logs } = makeCtx()
    // 'c' loses its only link to the model → nothing to rescue, stall is genuine.
    ctx.donePairs = [{ idA: 'a', idB: 'b', matches: [], inlierCount: 200 }]
    await registerImages(ctx)
    expect(logs.some(([, , m]) => /registration stalled/.test(m))).toBe(false)
  })
})

// ── In-registration self-cal identifiability (WS-C1, second call site) ────────
// Radial distortion is identifiable only from multi-view track redundancy, not from
// camera count. The post-filter passes already gate on this; the in-registration solves
// gated on `distortionCalMinCams` alone, so a 6+-camera model built from 2-view tracks
// refined f,k1 against nothing — BA lowered its cost while the focal ran away, and the
// fold baked the result into the keypoints. These pin the reduction at the rescue focal
// solve, the one in-registration BA reachable without wasm.
function makeRescueCtx({ nCams = 6, viewsPerTrack = 2, nTracks = 40, ...cfgOverrides } = {}) {
  const names = Array.from({ length: nCams }, (_, i) => `c${i}`)
  const K = { fx: 100, fy: 100, cx: 50, cy: 50 }
  const imgs = [...names, 'z'].map((n) => ({
    uuid: n, name: n, keypoints: [], meta: { width: 100, height: 100 },
  }))
  const cameras = new Map(names.map((n, i) => [n,
    { R: [[1, 0, 0], [0, 1, 0], [0, 0, 1]], t: [i, 0, 0], K }]))
  // 'z' is linked to the model but supplies no usable correspondences → the sweep
  // stalls with a linked image outstanding, which is the rescue's trigger.
  const donePairs = [
    ...names.slice(1).map((n) => ({ idA: names[0], idB: n, matches: [], inlierCount: 200 })),
    { idA: names[0], idB: 'z', matches: [], inlierCount: 200 },
  ]
  const points3d = Array.from({ length: nTracks }, (_, p) => ({
    x: p, y: 0, z: 10,
    views: new Map(names.slice(0, viewsPerTrack).map((n, i) => [n, i])),
  }))
  const logs = []
  const baCalls = []
  return {
    logs, baCalls,
    ctx: {
      imgs, donePairs, cameras,
      Kmap: new Map(imgs.map((i) => [i.uuid, K])),
      viewIndex: new Map(),
      registeredUuids: new Set(names),
      getPoints3d: () => points3d,
      cfg: {
        minMatchesForRegistration: 12, reprjThreshold: 4, pnpGateScale: 2,
        minPnpInliers: 15, minPnpInlierRatio: 0.3, minPnpRefineInlierRatio: 0.3,
        filterMaxReprojPx: 4, filterMinTriAngleDeg: 1.5,
        baIterations: 25, interimBaEvery: 5, interimBaIterations: 12,
        rescueStalled: true, rescueRefineRatio: 0.2, refineIntrinsics: 'f,k1',
        ...cfgOverrides,
      },
      addView: () => {},
      rebuildViewIndex: () => {},
      foldOneEndpointMatches: () => 0,
      mergeTracks: () => 0,
      runBundleAdjust: async (label, iters, mode) => { baCalls.push({ label, iters, mode }) },
      filterTracks: () => ({ obsRemoved: 0, ptsRemoved: 0 }),
      modelReprojStats: () => ({ p95: 1, median: 0.5, mean: 0.5 }),
      imageByUuid: (u) => imgs.find((i) => i.uuid === u),
      numStats: () => ({ mean: 0, median: 0 }),
      log: (m, level, cat) => logs.push([level, cat, m]),
    },
  }
}

describe('registerImages — in-registration self-cal identifiability (WS-C1)', () => {
  it('drops the radial terms on a 2-view-dominated model despite enough cameras', async () => {
    // 6 cameras clears distortionCalMinCams, so the old camera-count gate refined
    // 'f,k1' here — with zero ≥3-view tracks constraining k1.
    const { ctx, baCalls, logs } = makeRescueCtx({ nCams: 6, viewsPerTrack: 2 })
    await registerImages(ctx)
    const solve = baCalls.find((c) => /rescue focal solve/.test(c.label))
    expect(solve).toBeDefined()
    expect(solve.mode).toBe('f')
    expect(logs.some(([, , m]) => /in-registration self-cal reduced to 'f'/.test(m))).toBe(true)
  })

  it('keeps k1 when the tracks actually span ≥3 views', async () => {
    const { ctx, baCalls, logs } = makeRescueCtx({ nCams: 6, viewsPerTrack: 4 })
    await registerImages(ctx)
    const solve = baCalls.find((c) => /rescue focal solve/.test(c.label))
    expect(solve.mode).toBe('f,k1')
    expect(logs.some(([, , m]) => /in-registration self-cal/.test(m))).toBe(false)
  })

  it('refines nothing when too few cameras to identify even focal', async () => {
    // scope 'all' — below this the focal itself is unidentifiable, so the rescue's
    // intrinsics solve must not run at all.
    const { ctx, baCalls } = makeRescueCtx({ nCams: 2, viewsPerTrack: 2 })
    await registerImages(ctx)
    expect(baCalls.filter((c) => /rescue focal solve/.test(c.label))).toHaveLength(0)
  })

  it('stays off entirely when self-cal is disabled', async () => {
    const { ctx, baCalls, logs } = makeRescueCtx({ nCams: 6, refineIntrinsics: 'none' })
    await registerImages(ctx)
    expect(baCalls.filter((c) => /rescue focal solve/.test(c.label))).toHaveLength(0)
    expect(logs.some(([, , m]) => /in-registration self-cal/.test(m))).toBe(false)
  })
})
