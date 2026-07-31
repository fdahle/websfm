import { describe, expect, it } from 'vitest'
import { buildRunFingerprints } from './runFingerprint.js'

describe('run fingerprints', () => {
  const images = [{ uuid: 'b', name: 'b.jpg', keypoints: [{ x: 1, y: 2 }] }, { uuid: 'a', name: 'a.jpg', keypoints: [] }]
  const matches = [{ idA: 'a', idB: 'b', status: 'done', rawCount: 2, inlierCount: 1, matches: [[0, 1]] }]
  it('is stable across input order', () => {
    expect(buildRunFingerprints(images, matches)).toEqual(buildRunFingerprints([...images].reverse(), matches))
  })
  it('changes with feature coordinates or verified matches', () => {
    expect(buildRunFingerprints(images, matches).features)
      .not.toBe(buildRunFingerprints([{ ...images[0], keypoints: [{ x: 1.1, y: 2 }] }, images[1]], matches).features)
    expect(buildRunFingerprints(images, matches).matches)
      .not.toBe(buildRunFingerprints(images, [{ ...matches[0], inlierCount: 2 }]).matches)
  })
})
