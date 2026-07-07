import { describe, it, expect } from 'vitest'
import {
  guessMapping,
  buildSensors,
  exifSignature,
  exifLabel,
  sensorFromExif,
} from './sensor.js'

describe('guessMapping', () => {
  it('maps standard sensor headers', () => {
    const m = guessMapping(
      ['label', 'width', 'height', 'focal', 'cx', 'cy', 'k1', 'k2', 'p1', 'p2', 'pixelSize'],
      11,
      true,
    )
    expect(m).toMatchObject({
      label: 0, width: 1, height: 2, focal: 3, cx: 4, cy: 5,
      k1: 6, k2: 7, p1: 8, p2: 9, pixelSize: 10,
    })
  })

  it('recognises intrinsic aliases', () => {
    const m = guessMapping(['camera', 'cols', 'rows', 'fl', 'u0', 'v0'], 6, true)
    expect(m).toMatchObject({ label: 0, width: 1, height: 2, focal: 3, cx: 4, cy: 5 })
  })

  it('falls back positionally for label/width/height/focal only', () => {
    const m = guessMapping([], 6, false)
    expect(m).toMatchObject({ label: 0, width: 1, height: 2, focal: 3 })
    // Distortion/principal-point columns are never guessed positionally.
    expect(m.cx).toBeNull()
    expect(m.k1).toBeNull()
  })
})

describe('buildSensors', () => {
  const mapping = {
    label: 0, width: 1, height: 2, focal: 3, cx: 4, cy: 5,
    k1: null, k2: null, k3: null, p1: null, p2: null, pixelSize: null,
  }

  it('builds a numeric sensor from a valid row', () => {
    const { sensors, skipped } = buildSensors(
      [['CamA', '4000', '3000', '3500', '2000', '1500']],
      mapping,
    )
    expect(skipped).toBe(0)
    expect(sensors[0]).toMatchObject({
      label: 'CamA', width: 4000, height: 3000, focal: 3500, cx: 2000, cy: 1500,
    })
  })

  it('synthesises a label when the label cell is empty', () => {
    const { sensors } = buildSensors([['', '4000', '3000', '3500', '', '']], mapping)
    expect(sensors[0].label).toBe('Sensor 1')
  })

  it('skips a row that carries no intrinsic value at all', () => {
    const { sensors, skipped } = buildSensors([['OnlyLabel', '', '', '', '', '']], mapping)
    expect(sensors).toHaveLength(0)
    expect(skipped).toBe(1)
  })

  it('coerces non-numeric intrinsic cells to null', () => {
    const { sensors } = buildSensors([['CamA', 'wide', '3000', '3500', '', '']], mapping)
    expect(sensors[0].width).toBeNull()
    expect(sensors[0].height).toBe(3000)
  })
})

describe('exifSignature', () => {
  it('returns a stable key combining make/model/focal/dimensions', () => {
    const meta = { make: 'DJI', model: 'FC6310', focalLength: 8.8, width: 5472, height: 3648 }
    expect(exifSignature(meta)).toBe('DJI|FC6310|f8.8|5472x3648')
  })

  it('collapses to the fields that are present', () => {
    expect(exifSignature({ make: 'DJI', model: 'FC6310' })).toBe('DJI|FC6310')
  })

  it('returns null when EXIF carries nothing usable', () => {
    expect(exifSignature({})).toBeNull()
    expect(exifSignature(null)).toBeNull()
  })

  it('omits dimensions unless both width and height are present', () => {
    expect(exifSignature({ make: 'X', width: 100 })).toBe('X')
  })
})

describe('exifLabel', () => {
  it('joins camera name and focal length', () => {
    expect(exifLabel({ make: 'DJI', model: 'FC6310', focalLength: 8.8 })).toBe('DJI FC6310 · 8.8mm')
  })

  it('falls back to "Unknown camera" when no make/model', () => {
    expect(exifLabel({ focalLength: 24 })).toBe('Unknown camera · 24mm')
    expect(exifLabel({})).toBe('Unknown camera')
    expect(exifLabel(null)).toBe('Unknown camera')
  })
})

describe('sensorFromExif', () => {
  it('seeds a sensor with focal in mm and centred principal point', () => {
    const s = sensorFromExif({ make: 'DJI', model: 'FC6310', focalLength: 8.8, width: 5472, height: 3648 })
    expect(s).toMatchObject({
      width: 5472, height: 3648, focal: 8.8, focalUnit: 'mm', cx: 2736, cy: 1824,
    })
    expect(s.k1).toBeNull()
    expect(s.pixelSize).toBeNull()
  })

  it('leaves dimensions and derived principal point null when absent', () => {
    const s = sensorFromExif({ focalLength: 24 })
    expect(s).toMatchObject({ width: null, height: null, focal: 24, cx: null, cy: null })
  })
})
