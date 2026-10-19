import { expect, it } from 'vitest'
import { referenceGcpCandidates, spreadCandidates, candidateCoverage, referenceSigma, pixelSizeAt, referencePick } from './referenceGcps.js'
import { SparsePoints } from './sparsePoints.js'
function fixture() {
  return {
    points: SparsePoints.fromRecords([{ x: 20.5, y: 69.5, z: 0, viewsPx: new Map([['a',[11,12]],['b',[13,14]]]) }]),
    images: [{ uuid: 'a', name: 'a.jpg', toScan: (x,y) => ({ x:x+100, y:y+200 }) }, { uuid: 'b', name: 'b.jpg' }],
    ortho: { width: 100, height: 100, originX: 0, originY: 100, gsd: 1, frame: { kind: 'local', origin: [0,0,0], east:[1,0,0], north:[0,1,0], up:[0,0,1] } },
    reference: { width: 100, height: 100, geoTransform: { originX: 1000, originY: 2000, scaleX: 2, scaleY: -2 } },
    // Native pixel-edge coordinates: the track sits at ortho (20.5, 30.5), ½ px from the match.
    matches: [{ a:[20,30], b:[25,35], tile: 0, residual: 0.25 }],
    tiles: [{ H: [1,0,5,0,1,5,0,0,1], inliers: 30, ratio: 1 }],
  }
}
it('maps a verified local match to reference coordinates and original photo measurements', () => {
  const result = referenceGcpCandidates(fixture())
  expect(result).toHaveLength(1)
  // Reference pixel (25.5, 35.5) on a 2-unit grid at (1000, 2000).
  expect(result[0]).toMatchObject({ x:1051, y:1929, z:null, reference: [25.5, 35.5], residual: 0.25, residualRefPx: 0.25,
    observations: [{ imageName:'a.jpg', px:111, py:212 }, { imageName:'b.jpg', px:13.5, py:14.5 }] }) // b: no mapper, so only the mark-convention half pixel
  expect(result[0].offsetPx).toBeCloseTo(Math.SQRT1_2, 9)
  expect(result[0].confidence).toBeCloseTo(Math.exp(-0.5 * 0.0625) * 0.8, 9) // two-photo track
})
it('never invents image observations or accepts distant tracks', () => {
  const f = fixture(); f.images.pop()
  expect(referenceGcpCandidates(f)).toEqual([])
  f.images.push({ uuid:'b', name:'b.jpg' }); f.matches[0].a = [70,80]
  expect(referenceGcpCandidates(f)).toEqual([])
})
it('reads the distance gate in working pixels: a 4× finer ortho widens it 4×', () => {
  const f = fixture(); f.matches[0].a = [17, 30] // 3.5 ortho px from the track
  expect(referenceGcpCandidates(f)).toEqual([])
  expect(referenceGcpCandidates({ ...f, kl: 4 })).toHaveLength(1)
})
it('spreads candidates over the block before taking a second one from a cell', () => {
  const at = (x, y, confidence) => ({ local: [x, y], confidence })
  // Ten strong matches in one corner, one weaker in each other quadrant.
  const pool = [...Array.from({ length: 10 }, (_, i) => at(10 + 30 * i, 10, 0.9)), at(900, 100, 0.4), at(100, 900, 0.3), at(900, 900, 0.2)]
  const chosen = spreadCandidates(pool, 1000, 1000, { limit: 4, minSeparation: 24 })
  expect(chosen.map(c => c.local)).toEqual([[10, 10], [900, 100], [100, 900], [900, 900]])
  expect(candidateCoverage(chosen, 1000, 1000)).toMatchObject({ cells: 4, of: 16 })
  expect(candidateCoverage(chosen, 1000, 1000).hull).toBeCloseTo(0.712, 9) // shoelace over the four corners
})
it('takes planimetric accuracy from the pixel size unless the reference declares its own', () => {
  expect(referenceSigma({ gsd: 0.5 })).toBe(0.5)
  expect(referenceSigma({ gsd: 0.5, residualPx: 3 })).toBe(1.5)
  expect(referenceSigma({ gsd: 0.5, residualPx: 3, declared: 2 })).toBeCloseTo(2.5, 12)
  expect(referenceSigma({ gsd: 0 })).toBeNull()
  // A 2-unit grid into a CRS that doubles lengths: 4 project units per pixel.
  expect(pixelSizeAt(fixture().reference, 10, 10, ([x, y]) => [2 * x, 2 * y])).toBe(4)
})
it('reads a pick off a reference: position in project units, σ from the pixel as drawn', () => {
  const ref = fixture().reference, toProject = ([x, y]) => [x + 100, y - 100]
  // Pixel (10, 20)'s centre on a 2-unit grid at (1000, 2000).
  expect(referencePick(ref, 10.5, 20.5, { toProject })).toEqual({ x: 1121, y: 1859, gsd: 2, sigma: 2 })
  // Only a 4× downsampled preview on screen: a click is good to 4 native pixels.
  expect(referencePick(ref, 10.5, 20.5, { toProject, displayFactor: 4 }).sigma).toBe(8)
  // A declared 6-unit accuracy dominates and the click adds in quadrature.
  expect(referencePick(ref, 10.5, 20.5, { toProject, displayFactor: 4, declared: 6 }).sigma).toBeCloseTo(10, 12)
})
it('measures σ in metres for a geographic project', () => {
  // A 0.001° grid at 60° S: one pixel is 111.32 m north–south and half that east–west.
  const ref = { geoTransform: { originX: 10, originY: -60, scaleX: 0.001, scaleY: -0.001 } }, toProject = (p) => p
  const pick = referencePick(ref, 0.5, 0.5, { toProject, geographic: true })
  expect(pick.x).toBeCloseTo(10.0005, 12)
  expect(pick.gsd).toBeCloseTo((111.32 + 111.32 * Math.cos(-60.0005 * Math.PI / 180)) / 2, 6)
})
