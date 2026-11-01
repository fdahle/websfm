import { describe, expect, it } from 'vitest'
import { gapDetectSettings, planGapRedetect } from './gapRedetect.js'

// A block of 10 photos (m0…m9) with a piece of 3 (g0…g2) beside it. Each gap photo has
// candidate pairs with some of the block's; m0 pairs with all three, m1 with two.
const main = Array.from({ length: 10 }, (_, i) => `m${i}`)
const gap = ['g0', 'g1', 'g2']
const piece = { ids: gap, target: new Set(main) }
const pair = (idA, idB, rawCount = 10) => ({ idA, idB, rawCount, status: 'done', inlierCount: 0 })
const entries = [
  pair('g0', 'm0'),
  pair('g1', 'm0'),
  pair('g2', 'm0'),
  pair('m1', 'g0', 5),
  pair('m1', 'g1', 5),
  pair('m2', 'g2', 40),
  pair('m3', 'g2', 4),
  pair('g0', 'g1', 99), // inside the piece: no partner
  pair('m4', 'm5', 99), // inside the block
]
const scans = (scale) => new Map([...main, ...gap].map((id) => [id, { detector: 'sift', detectScale: scale }]))

describe('planGapRedetect', () => {
  it('picks the gap photos and the block photos with candidate pairs to most of them', () => {
    const plan = planGapRedetect({ pieces: [piece], entries, images: scans(0.385), imageCount: 13 })
    expect(plan.skipped).toBe(null)
    expect(plan.loose).toEqual(gap)
    expect(plan.apart).toBe(3)
    expect(plan.scale).toBe(0.385)
    // ⌈0.65 × 3⌉ = 2: m0 (3 gap photos), then m1 (2); m2's one pair has more putatives
    // than m1's two, but pairs with fewer of them.
    expect(plan.partners).toEqual(['m0', 'm1'])
  })

  it('ranks partners with as many gap photos by their putatives', () => {
    const plan = planGapRedetect({
      pieces: [piece],
      entries,
      images: scans(0.385),
      imageCount: 20, // room for every partner within half the photos
      opts: { partnerShare: 1.5 },
    })
    expect(plan.partners).toEqual(['m0', 'm1', 'm2', 'm3'])
  })

  it('keeps the features of a partner already detected at full size', () => {
    const images = scans(0.385)
    images.set('m0', { detector: 'sift', detectScale: 1 })
    const plan = planGapRedetect({ pieces: [piece], entries, images, imageCount: 13 })
    expect(plan.partners).toEqual(['m1'])
  })

  it('plans nothing when there is no gap, or detecting again adds nothing', () => {
    const plan = (images, pieces = [piece]) => planGapRedetect({ pieces, entries, images, imageCount: 13 })
    expect(plan(scans(0.385), []).skipped).toBe('none')
    expect(plan(scans(1)).skipped).toBe('native')
    expect(plan(scans(0.85)).skipped).toBe('native')
    const disk = new Map([...main, ...gap].map((id) => [id, { detector: 'disk', detectScale: 0.4 }]))
    expect(plan(disk).skipped).toBe('learned')
  })

  it('leaves a gap of more than half the photos to a full-size detection of all', () => {
    expect(planGapRedetect({ pieces: [piece], entries, images: scans(0.4), imageCount: 5 }).skipped).toBe('many')
    // Room for the gap but not for every partner: they are trimmed to fit.
    const plan = planGapRedetect({ pieces: [piece], entries, images: scans(0.4), imageCount: 8 })
    expect(plan.loose).toEqual(gap)
    expect(plan.partners).toEqual(['m0'])
  })
})

describe('gapDetectSettings', () => {
  const im = (detectScale, side, detectSettings) => ({
    detectScale,
    meta: { width: side, height: side - 200 },
    detectSettings,
  })

  it('detects at the largest native size, tiled, with the cap scaled with the area', () => {
    const s = gapDetectSettings([
      im(0.385, 10400, {
        maxKeypointsEffective: 4000,
        contrastThreshold: 0.01,
        maxOrientations: 1,
        capRule: 'coarse-first',
      }),
      im(0.4, 10000, null),
    ])
    expect(s).toEqual({
      detector: 'sift',
      maxDimMode: 'absolute',
      maxDim: 10400,
      tiling: 'on',
      maxKeypoints: Math.round(4000 / 0.385 ** 2),
      contrastThreshold: 0.01,
      maxOrientations: 1,
      capRule: 'coarse-first',
    })
  })

  it('stops the cap at maxKeypoints', () => {
    expect(gapDetectSettings([im(0.2, 8000, { maxKeypoints: 8000 })]).maxKeypoints).toBe(40000)
  })
})
