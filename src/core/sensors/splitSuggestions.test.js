import { describe, expect, it } from 'vitest'
import { estimateBatchFiducialLayout } from '../sfm/fiducialCalibration.js'
import { rollOf, splitBy, suggestSensorSplits } from './splitSuggestions.js'

const PITCH = 0.025 // mm per scan pixel
// Eight marks of a 230 mm frame: corners and midsides (mm, y up).
const LAYOUT = {
  corner_top_left: [-113, 113],
  corner_top_right: [113, 113],
  corner_bottom_right: [113, -113],
  corner_bottom_left: [-113, -113],
  midside_top: [0, 113],
  midside_right: [113, 0],
  midside_bottom: [0, -113],
  midside_left: [-113, 0],
}
// A small deterministic jitter (±0.5 px) so the fits are not exact.
const jitter = (i, k) => ((((i * 7919 + k * 104729) % 1000) / 1000) * 2 - 1) * 0.5

// A scanned photo: its marks in scan pixels. `moved` displaces the midside marks (mm),
// as a camera with another mark layout would.
function scan(name, i, { size = [10200, 10400], moved = 0 } = {}) {
  const [w, h] = size
  const fiducialDetections = Object.entries(LAYOUT).map(([slot, [x, y]], k) => {
    const shift = slot.startsWith('midside') ? moved : 0
    return {
      slot,
      px: w / 2 + (x + shift) / PITCH + jitter(i, k),
      py: h / 2 - (y + shift) / PITCH + jitter(i, 2 * k + 1),
    }
  })
  return { id: name, name: `${name}.tif`, sensorId: 's', meta: { width: w, height: h }, fiducialDetections }
}

const roll = (prefix, n, opts, from = 0) =>
  Array.from({ length: n }, (_, k) => scan(`${prefix}${String(81 + k).padStart(4, '0')}`, from + k, opts))

function filmSensor(images) {
  return { id: 's', label: 'Camera L', kind: 'film', fiducialCalibration: estimateBatchFiducialLayout(images, PITCH) }
}

describe('rollOf', () => {
  it('is the file name without its frame number', () => {
    expect(rollOf('CA215731L0040.tif')).toBe('CA215731L')
    expect(rollOf('DJI_0012.JPG')).toBe('DJI')
    expect(rollOf('scan-7.tiff')).toBe('scan')
    expect(rollOf('IMG.jpg')).toBe(null)
    expect(rollOf('0040.tif')).toBe(null)
  })
})

describe('suggestSensorSplits', () => {
  it('splits a film group by scan format and by the roll that misfits the mark layout', () => {
    const images = [
      ...roll('CA213731L', 13),
      ...roll('CA214831L', 12, {}, 20),
      ...roll('CA215731L', 11, { size: [10130, 9600], moved: 0.15 }, 40),
    ]
    const [s] = suggestSensorSplits({ sensors: [filmSensor(images)], images })
    expect(s.sensorId).toBe('s')
    // One split, both kinds of evidence agree on it.
    expect(s.groups.map((g) => [g.label, g.imageIds.length, g.small])).toEqual([
      ['Camera L · 10200×10400', 25, false],
      ['Camera L · 10130×9600 · CA215731L', 11, false],
    ])
    expect(s.formats).toEqual([
      { key: '10130×9600', images: 11 },
      { key: '10200×10400', images: 25 },
    ])
    expect(s.misfits.map((m) => m.roll)).toEqual(['CA215731L'])
    expect(s.misfits[0].medianUm).toBeGreaterThan(3 * s.misfits[0].othersUm)
  })

  it('finds a misfit roll among scans of one size', () => {
    const images = [...roll('A', 12), ...roll('B', 12, {}, 20), ...roll('C', 4, { moved: 0.15 }, 40)]
    const [s] = suggestSensorSplits({ sensors: [filmSensor(images)], images })
    expect(s.formats).toEqual([])
    expect(s.groups.map((g) => [g.label, g.imageIds.length, g.small])).toEqual([
      ['Camera L', 24, false],
      ['Camera L · C', 4, true], // under 10 photos: fewer self-calibration terms
    ])
  })

  it('splits two scan batches a few pixels apart', () => {
    const images = [...roll('V', 12, { size: [10137, 9600] }), ...roll('W', 12, { size: [10141, 9600] }, 20)]
    const [s] = suggestSensorSplits({ sensors: [filmSensor(images)], images })
    expect(s.groups.map((g) => [g.label, g.imageIds.length])).toEqual([
      ['Camera L · 10137×9600', 12],
      ['Camera L · 10141×9600', 12],
    ])
  })

  it('keeps one camera together when each frame was cropped to its own size', () => {
    const images = roll('V', 24, {}).map((im, i) => ({ ...im, meta: { width: 10130 + 3 * i, height: 9600 + (i % 5) } }))
    expect(suggestSensorSplits({ sensors: [filmSensor(images)], images })).toEqual([])
  })

  it('splits a digital group by format alone, and skips a group of one photo', () => {
    const images = [
      { id: 'a', name: 'a1.jpg', sensorId: 'd', meta: { width: 6000, height: 4000 } },
      { id: 'b', name: 'b1.jpg', sensorId: 'd', meta: { width: 4000, height: 3000 } },
      { id: 'c', name: 'c1.jpg', sensorId: 'e', meta: { width: 4000, height: 3000 } },
    ]
    const sensors = [
      { id: 'd', label: 'Sensor 1' },
      { id: 'e', label: 'Sensor 2' },
    ]
    const out = suggestSensorSplits({ sensors, images })
    expect(out).toHaveLength(1)
    expect(out[0].groups.map((g) => [g.label, g.imageIds])).toEqual([
      ['Sensor 1 · 6000×4000', ['a']], // as large as the other: in the photos' order
      ['Sensor 1 · 4000×3000', ['b']],
    ])
  })
})

describe('splitBy', () => {
  const images = [...roll('CA213731L', 3), ...roll('CA215731L', 2, { size: [10130, 9600] }, 10)]
  const sensor = { id: 's', label: 'Camera L' }
  it('groups by scan format or by roll, largest first', () => {
    expect(splitBy(sensor, images, 'format').map((g) => [g.label, g.imageIds.length])).toEqual([
      ['Camera L · 10200×10400', 3],
      ['Camera L · 10130×9600', 2],
    ])
    expect(splitBy(sensor, images, 'roll').map((g) => [g.label, g.imageIds.length, g.small])).toEqual([
      ['Camera L · CA213731L', 3, true],
      ['Camera L · CA215731L', 2, true],
    ])
  })
  it('keeps the label when nothing splits', () => {
    expect(splitBy(sensor, images.slice(0, 3), 'roll').map((g) => g.label)).toEqual(['Camera L'])
  })
})
