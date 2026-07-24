import { describe, it, expect } from 'vitest'
import { profileDataset } from './profile.js'

// Small helpers to keep the fixtures readable.
const img = (name, meta = {}) => ({ name, meta })
const seq = (prefix, n, meta) => Array.from({ length: n }, (_, i) => img(`${prefix}${String(i + 1).padStart(4, '0')}.jpg`, meta))

describe('profileDataset', () => {
  it('classifies a scanned film set (no EXIF) and tags it tentative', () => {
    const images = seq('CA213732V', 12, { width: 11000, height: 11000 })
    const p = profileDataset({ images, sensors: [], poses: [], gcps: [] })
    expect(p.kind).toBe('film')
    expect(p.nImages).toBe(12)
    expect(p.maxDim).toBe(11000)
    expect(p.minDim).toBe(11000)
    expect(p.medianMP).toBeCloseTo(121, 0)
    expect(p.hasGps).toBe(false)
    expect(p.sequentialNames).toBe(true)
    expect(p.notes.some((n) => /tentative/i.test(n))).toBe(true)
  })

  it('prefers a declared film sensor over the EXIF heuristic (not tentative)', () => {
    // Images carry EXIF (so the "no EXIF" path would NOT fire), but the sensor is film.
    const images = seq('scan_', 5, { width: 8000, height: 8000, make: 'Zeiss', model: 'RMK' })
    const p = profileDataset({ images, sensors: [{ id: 's1', kind: 'film' }] })
    expect(p.kind).toBe('film')
    expect(p.notes.some((n) => /kind:"film"/.test(n))).toBe(true)
    expect(p.notes.some((n) => /tentative/i.test(n))).toBe(false)
  })

  it('classifies a drone set from make/model and surfaces GPS + poses', () => {
    const images = seq('DJI_', 30, {
      width: 5472, height: 3648, make: 'DJI', model: 'FC6310', focalLength: 8.8,
      gpsLat: 47.1, gpsLon: 8.2,
    })
    const p = profileDataset({ images, poses: [{ imageId: 'a' }] })
    expect(p.kind).toBe('drone')
    expect(p.hasGps).toBe(true)
    expect(p.hasPoses).toBe(true)
    expect(p.scale).toBe('medium')
  })

  it('classifies a phone set by make', () => {
    const images = seq('IMG_', 8, { width: 4032, height: 3024, make: 'Apple', model: 'iPhone 14', focalLength: 5.7 })
    const p = profileDataset({ images })
    expect(p.kind).toBe('phone')
    expect(p.scale).toBe('small')
  })

  it('no-metadata: everything null/unknown but does not throw', () => {
    const images = [img('a.png'), img('b.png')]
    const p = profileDataset({ images })
    // Only two images, no EXIF ⇒ film heuristic fires (nImages >= 2, no EXIF).
    expect(p.kind).toBe('film')
    expect(p.minDim).toBeNull()
    expect(p.maxDim).toBeNull()
    expect(p.medianMP).toBeNull()
    expect(p.notes.some((n) => /No image dimensions/.test(n))).toBe(true)
  })

  it('a single EXIF-bearing image is not force-classified as film', () => {
    const p = profileDataset({ images: [img('x.jpg', { width: 4000, height: 3000, make: 'Canon', model: 'EOS 5D' })] })
    // No known drone/phone make, EXIF present ⇒ unknown, never the no-EXIF film path.
    expect(p.kind).toBe('unknown')
  })

  it('detects sequential names and rejects a shuffled/gappy set', () => {
    expect(profileDataset({ images: seq('frame', 6, { width: 100, height: 100 }) }).sequentialNames).toBe(true)
    // Big non-contiguous jumps break the run.
    const gappy = [img('a10.jpg'), img('a900.jpg'), img('a3.jpg'), img('a5000.jpg')]
    expect(profileDataset({ images: gappy }).sequentialNames).toBe(false)
  })

  it('flags calibrated distortion only for a non-zero declared coefficient', () => {
    const images = seq('c', 4, { width: 6000, height: 4000, make: 'Canon' })
    expect(profileDataset({ images, sensors: [{ k1: -0.13 }] }).hasCalibratedDistortion).toBe(true)
    expect(profileDataset({ images, sensors: [{ k1: 0 }] }).hasCalibratedDistortion).toBe(false)
    expect(profileDataset({ images, sensors: [{ k1: null }] }).hasCalibratedDistortion).toBe(false)
  })

  it('flags mixed resolutions when the long edge spans >1.5×', () => {
    const images = [
      img('a.jpg', { width: 2000, height: 1500 }),
      img('b.jpg', { width: 6000, height: 4000 }),
    ]
    const p = profileDataset({ images })
    expect(p.minDim).toBe(2000)
    expect(p.maxDim).toBe(6000)
    expect(p.notes.some((n) => /Mixed resolutions/.test(n))).toBe(true)
  })

  it('buckets scale by image count', () => {
    expect(profileDataset({ images: seq('a', 10, {}) }).scale).toBe('small')
    expect(profileDataset({ images: seq('a', 50, {}) }).scale).toBe('medium')
    expect(profileDataset({ images: seq('a', 250, {}) }).scale).toBe('large')
  })

  it('handles empty input', () => {
    const p = profileDataset({})
    expect(p.nImages).toBe(0)
    expect(p.kind).toBe('unknown')
    expect(p.sequentialNames).toBe(false)
  })
})
