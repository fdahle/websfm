import { describe, it, expect } from 'vitest'
import { detectTargetsEffects } from './detectTargets.js'

const s = { sizeM: 0.6, searchPx: 30, minScore: 0.4, replaceDetected: true }

describe('detectTargetsEffects', () => {
  it('sizes the targets, counts the search and says what stays', () => {
    const e = detectTargetsEffects(s, { halfPx: 12.4, predictions: 40, photos: 12, gcps: 5, unplaced: 1 })
    expect(e.targets).toBe('Checker mats of 0.6 m, about 25 px across in these photos.')
    expect(e.search).toBe(
      '40 places in 12 photos for 5 GCPs, each searched within 30 px of where the model puts it; 1 GCP without coordinates or two marks left out.',
    )
    expect(e.marks).toBe(
      'A detection needs a score of 0.4 or more; marks you placed stay, earlier detections are replaced.',
    )
  })
  it('says why there is nothing to do, and what an unscaled model means', () => {
    const e = detectTargetsEffects({ ...s, replaceDetected: false })
    expect(e.search).toMatch(/^Nothing to look for/)
    expect(e.targets).toMatch(/no scale/)
    expect(e.marks).toMatch(/and so do earlier detections\.$/)
  })
  it('describes an AprilTag run', () => {
    const e = detectTargetsEffects({ ...s, kind: 'apriltag', addMarkers: true }, { photos: 30, gcps: 6, tagged: 5 })
    expect(e.targets).toBe(
      'AprilTag 36h11 tags: a GCP stands for the tag with the number in its name (5 of 6 GCPs have one).',
    )
    expect(e.search).toBe('Every tag in each of 30 photos, the whole frame at full resolution; no model needed.')
    expect(e.marks).toBe(
      'Marks you placed stay, earlier detections are replaced; a tag no GCP is named after becomes a marker "Tag N".',
    )
    const off = detectTargetsEffects({ ...s, kind: 'apriltag', addMarkers: false }, { photos: 1, gcps: 0 })
    expect(off.targets).toMatch(/no GCPs yet/)
    expect(off.marks).toMatch(/is left out\.$/)
  })
})
