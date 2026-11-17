import { describe, expect, it } from 'vitest'
import { planExifSensors } from './exifGroups.js'
import { sensorGroupOf, sameScanFormat } from '../io/sensor.js'
import { SENSOR_TUNING } from '../tuning.js'

// Run the plan on images, numbering new sensors s1, s2 … → { sensors, byImage, labels }.
function plan(images, sensors = []) {
  let id = 0
  let n = 1
  const { created, assign } = planExifSensors(images, sensors, {
    tolFrac: SENSOR_TUNING.formatTolFrac,
    newId: () => `s${++id}`,
    nextNumber: () => n++,
  })
  const all = [...sensors, ...created]
  const byImage = new Map(assign)
  const label = (imageId) => all.find((s) => s.id === byImage.get(imageId))?.label
  return { created, byImage, label }
}

const scan = (name, width, height, extra = {}) => ({ id: name, name, meta: { width, height, ...extra } })

describe('planExifSensors on film scans', () => {
  // Rolls and sizes of the TMA Rachel set (several frames each). The R scans' scanner
  // tags are already gone (core/io/scanners.js), so no scan names a camera.
  const rachel = [
    scan('CA214732V0046.tif', 10140, 9872),
    scan('CA214732V0048.tif', 10141, 9872),
    scan('CA214733R0046.tif', 10200, 10772),
    scan('CA214833R0072.tif', 10200, 10772),
    scan('CA215033R0100.tif', 10200, 10772),
    scan('CA215731L0040.tif', 10130, 9872),
    scan('CA215732V0040.tif', 10130, 9872),
    scan('CA215733R0041.tif', 10132, 9872),
    scan('CA215733R0042.tif', 10134, 9872),
  ]

  it('makes one sensor per roll, named after it', () => {
    const { created, label } = plan(rachel)
    expect(created.map((s) => s.label)).toEqual([
      'CA214732V',
      'CA214733R',
      'CA214833R',
      'CA215033R',
      'CA215731L',
      'CA215732V',
      'CA215733R',
    ])
    // Frames of one roll cropped a pixel or two apart stay together.
    expect(label('CA214732V0048.tif')).toBe('CA214732V')
    expect(label('CA215733R0042.tif')).toBe('CA215733R')
  })

  it('keeps apart the rolls one scan size used to merge', () => {
    const { byImage } = plan(rachel)
    // Same size, two cameras of one flight.
    expect(byImage.get('CA215731L0040.tif')).not.toBe(byImage.get('CA215732V0040.tif'))
    // Same size, the R cameras of three flights.
    expect(byImage.get('CA214733R0046.tif')).not.toBe(byImage.get('CA214833R0072.tif'))
  })

  it('gives a second scan format of one roll a sensor of its own', () => {
    const { created, label } = plan([scan('roll7-001.tif', 10000, 10000), scan('roll7-002.tif', 9000, 10000)])
    expect(created).toHaveLength(2)
    expect(label('roll7-002.tif')).toBe('roll7 (2)')
  })

  it('joins an existing sensor of the roll, and leaves a bound image alone', () => {
    const first = plan([scan('CA214732V0046.tif', 10140, 9872)])
    const sensors = first.created
    const next = plan(
      [
        scan('CA214732V0049.tif', 10141, 9872),
        { ...scan('CA214732V0050.tif', 10141, 9872), sensorId: 'mine' },
        { ...scan('CA214732V0051.tif', 10141, 9872), sensorId: sensors[0].id },
      ],
      [...sensors, { id: 'mine', label: 'Mine' }],
    )
    expect(next.created).toHaveLength(0)
    expect(next.byImage.get('CA214732V0049.tif')).toBe(sensors[0].id)
    expect(next.byImage.has('CA214732V0050.tif')).toBe(false)
    expect(next.byImage.has('CA214732V0051.tif')).toBe(false)
  })

  it('groups scans without a roll in the name by exact size, as "Sensor N"', () => {
    const { created, label } = plan([
      scan('001.tif', 8000, 8000),
      scan('002.tif', 8000, 8000),
      scan('003.tif', 8001, 8000),
    ])
    expect(created.map((s) => s.label)).toEqual(['Sensor 1', 'Sensor 2'])
    expect(label('002.tif')).toBe('Sensor 1')
  })
})

describe('planExifSensors on camera photos', () => {
  it('groups by make, model, focal length and size, whatever the file names', () => {
    const cam = (name, focalLength) => ({
      id: name,
      name,
      meta: { make: 'DJI', model: 'FC6310', focalLength, width: 5472, height: 3648 },
    })
    const { created, byImage } = plan([
      cam('DJI_0001.JPG', 8.8),
      cam('DJI_0002.JPG', 8.8),
      cam('X_0001.JPG', 8.8),
      cam('DJI_0003.JPG', 24),
    ])
    expect(created.map((s) => s.label)).toEqual(['DJI FC6310 · 8.8mm', 'DJI FC6310 · 24mm'])
    expect(byImage.get('X_0001.JPG')).toBe(byImage.get('DJI_0001.JPG'))
  })
})

describe('sensorGroupOf', () => {
  it('uses the roll only when the tags name no camera', () => {
    expect(sensorGroupOf({ width: 10, height: 10 }, 'CA214732V0046.tif')).toEqual({
      key: 'roll:CA214732V',
      roll: 'CA214732V',
    })
    expect(sensorGroupOf({ make: 'Canon', width: 10, height: 10 }, 'IMG_0001.JPG').roll).toBeNull()
    expect(sensorGroupOf({}, 'CA214732V0046.tif').key).toBe('roll:CA214732V')
    expect(sensorGroupOf({}, '001.tif')).toBeNull()
    expect(sensorGroupOf(null, 'CA214732V0046.tif')).toBeNull()
  })
})

describe('sameScanFormat', () => {
  it('takes sizes within the tolerance as one format', () => {
    const s = { width: 10140, height: 9872 }
    expect(sameScanFormat(s, { width: 10141, height: 9872 }, 0.01)).toBe(true)
    expect(sameScanFormat(s, { width: 10200, height: 10772 }, 0.01)).toBe(false)
  })
})
