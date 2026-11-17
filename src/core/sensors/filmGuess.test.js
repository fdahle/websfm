import { describe, expect, it } from 'vitest'
import { filmScanGuess } from './filmGuess.js'

// A TMA scan as Rachel's arrive: no tags, roll name, 10141 × 9872, one channel.
const scan = (name, sensorId, extra = {}) => ({
  name,
  sensorId,
  meta: { width: 10141, height: 9872, channels: 1, ...extra },
})

describe('filmScanGuess', () => {
  it('asks about untagged, square, greyscale scans with roll names', () => {
    const out = filmScanGuess({
      sensors: [{ id: 'a' }, { id: 'b' }],
      images: [scan('CA214732V0046.tif', 'a'), scan('CA214732V0047.tif', 'a'), scan('CA214733R0046.tif', 'b')],
    })
    expect(out).toEqual({ sensorIds: ['a', 'b'], images: 3, signs: ['roll', 'square', 'grey'] })
  })

  it('needs two signs without scanner tags', () => {
    // A roll-like name alone is a digital frame stripped of its tags (ETH3D DSC_0001.JPG).
    const eth3d = { name: 'DSC_0001.JPG', sensorId: 'a', meta: { width: 6214, height: 4141, channels: null } }
    expect(filmScanGuess({ sensors: [{ id: 'a' }], images: [eth3d] })).toBeNull()
    // Square and greyscale, but named 001.tif … : still two signs.
    const plain = { ...scan('frame.tif', 'a') }
    expect(filmScanGuess({ sensors: [{ id: 'a' }], images: [plain] })?.signs).toEqual(['square', 'grey'])
  })

  it('takes scanner tags on their own', () => {
    const img = { name: 'photo.tif', sensorId: 'a', meta: { width: 8000, height: 5000, scan: { device: 'X' } } }
    expect(filmScanGuess({ sensors: [{ id: 'a' }], images: [img] })?.signs).toEqual(['scanner'])
  })

  it('never asks about camera photos, classified sensors or metadata still loading', () => {
    const tagged = scan('CA214732V0046.tif', 'a', { make: 'DJI', model: 'FC6310' })
    expect(filmScanGuess({ sensors: [{ id: 'a' }], images: [tagged] })).toBeNull()
    for (const kind of ['film', 'digital'])
      expect(filmScanGuess({ sensors: [{ id: 'a', kind }], images: [scan('CA214732V0046.tif', 'a')] })).toBeNull()
    const loading = { name: 'CA214732V0047.tif', sensorId: 'a', meta: null }
    expect(filmScanGuess({ sensors: [{ id: 'a' }], images: [scan('CA214732V0046.tif', 'a'), loading] })).toBeNull()
  })

  it('reports only the signs every candidate shows', () => {
    const colour = scan('CA215732V0039.tif', 'b', { channels: 3 })
    const out = filmScanGuess({ sensors: [{ id: 'a' }, { id: 'b' }], images: [scan('CA214732V0046.tif', 'a'), colour] })
    expect(out.signs).toEqual(['roll', 'square'])
  })
})
