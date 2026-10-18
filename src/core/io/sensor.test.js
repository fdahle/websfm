import { describe, it, expect } from 'vitest'
import {
  guessMapping,
  buildSensors,
  exifSignature,
  exifLabel,
  sensorFromExif,
  guessFocalUnit,
  planSensorImport,
  sensorImportImageIds,
  parseRows,
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

  it('leaves the label empty when the label cell is (the store numbers new sensors)', () => {
    const { sensors } = buildSensors([['', '4000', '3000', '3500', '', '']], mapping)
    expect(sensors[0].label).toBeNull()
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

describe('lens model columns', () => {
  it('maps k4…k6 and a lens-model column', () => {
    const m = guessMapping(['label', 'focal', 'distortion_model', 'k1', 'k2', 'k3', 'k4', 'k5', 'k6'], 9, true)
    expect(m).toMatchObject({ label: 0, focal: 1, distortionModel: 2, k1: 3, k4: 6, k5: 7, k6: 8 })
    // A bare "model" column is still a label (a camera body name).
    expect(guessMapping(['model', 'focal'], 2, true)).toMatchObject({ label: 0, distortionModel: null })
  })

  it('reads the named model, and leaves an unknown name to inference', () => {
    const m = guessMapping(['label', 'focal', 'lens_model', 'k1', 'k2', 'k3', 'k4'], 7, true)
    const { sensors } = buildSensors([
      ['GoPro', '1700', 'OPENCV_FISHEYE', '0.05', '-0.01', '0.002', '-0.0003'],
      ['Drone', '3500', 'whatever', '-0.1', '', '', ''],
    ], m)
    expect(sensors[0]).toMatchObject({ distortionModel: 'fisheye', k1: 0.05, k4: -0.0003 })
    expect(sensors[1].distortionModel).toBeNull()
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

  it('gives each video its own sensor, shared by its frames', () => {
    const a = exifSignature({ width: 1920, height: 1080, videoSource: 'walk.mp4' })
    expect(a).toBe('1920x1080|video:walk.mp4')
    expect(exifSignature({ width: 1920, height: 1080, videoSource: 'orbit.mov' })).not.toBe(a)
    expect(exifLabel({ width: 1920, height: 1080, videoSource: 'walk.mp4' })).toBe('Video walk.mp4')
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

// A film camera's calibration as one row: focal and pixel pitch, the principal point
// and eight fiducial marks in mm (the casa_grande preprocessing output).
const FILM_ROW = [
  'focal_length,pixel_pitch,corner_top_left_x_mm,corner_top_left_y_mm,corner_top_right_x_mm,corner_top_right_y_mm,'
  + 'corner_bottom_right_x_mm,corner_bottom_right_y_mm,corner_bottom_left_x_mm,corner_bottom_left_y_mm,'
  + 'midside_left_x_mm,midside_left_y_mm,midside_top_x_mm,midside_top_y_mm,midside_right_x_mm,midside_right_y_mm,'
  + 'midside_bottom_x_mm,midside_bottom_y_mm,principal_point_x_mm,principal_point_y_mm',
  '152.865,0.025,-105.998,105.985,105.996,106.006,106.001,-106.005,-105.983,-106.005,-110.004,-0.009,-0.003,109.999,'
  + '110.013,0.024,0.009,-109.992,-0.03,-0.001',
].join('\n')

describe('film calibration in one row', () => {
  const [header, ...rows] = parseRows(FILM_ROW, ',')
  const mapping = guessMapping(header, header.length, true)

  it('maps every column by header and guesses nothing by position', () => {
    expect(mapping).toMatchObject({ focal: 0, pixelSize: 1, ppxMm: 18, ppyMm: 19, label: null, width: null, height: null })
    expect(mapping['fid:corner-tl:x']).toBe(2)
    expect(mapping['fid:side-left:y']).toBe(11)
  })

  it('reads the focal length as mm and the marks into their slots', () => {
    expect(guessFocalUnit(header, mapping, rows)).toBe('mm')
    const { sensors } = buildSensors(rows, mapping, { focalUnit: 'mm' })
    expect(sensors).toHaveLength(1)
    expect(sensors[0]).toMatchObject({ focal: 152.865, focalUnit: 'mm', pixelSize: 0.025, ppxMm: -0.03, ppyMm: -0.001, images: null })
    expect(sensors[0].marks).toHaveLength(8)
    expect(sensors[0].marks[0]).toEqual({ id: 'corner-tl', slot: 'corner-tl', xMm: -105.998, yMm: 105.985 })
    expect(sensors[0].marks.find((m) => m.slot === 'side-left')).toMatchObject({ xMm: -110.004, yMm: -0.009 })
  })

  it('does not take scan-pixel fiducial columns (no mm) as marks', () => {
    const m = guessMapping(['image_id', 'corner_top_left_x', 'corner_top_left_y'], 3, true)
    expect(m.image).toBe(0)
    expect(m['fid:corner-tl:x']).toBeNull()
  })
})

describe('guessFocalUnit', () => {
  const rows = (v) => [[String(v)]]
  it('trusts a unit in the header', () => {
    expect(guessFocalUnit(['focal_mm'], { focal: 0 }, rows(3500))).toBe('mm')
    expect(guessFocalUnit(['fpx'], { focal: 0 }, rows(12))).toBe('px')
  })
  it('otherwise reads small values as mm and large ones as pixels', () => {
    expect(guessFocalUnit(['focal'], { focal: 0 }, rows(8.8))).toBe('mm')
    expect(guessFocalUnit(['focal'], { focal: 0 }, rows(3650))).toBe('px')
  })
})

describe('buildSensors with an image column', () => {
  const mapping = { ...guessMapping(['image', 'focal', 'cx'], 3, true) }
  it('collapses images with identical values into one sensor', () => {
    const { sensors } = buildSensors([['a.tif', '3500', '2000'], ['b.tif', '3500', '2000'], ['c.tif', '3600', '2000']], mapping)
    expect(sensors.map((s) => [s.focal, s.images])).toEqual([[3500, ['a.tif', 'b.tif']], [3600, ['c.tif']]])
  })
})

describe('planSensorImport', () => {
  const sensors = [{ id: 'A', label: 'Camera A' }, { id: 'B', label: 'Camera B' }]
  const images = [
    { id: 1, name: 'a.tif', sensorId: 'A' }, { id: 2, name: 'b.tif', sensorId: 'A' },
    { id: 3, name: 'c.tif', sensorId: 'B' }, { id: 4, name: 'd.tif', sensorId: null },
  ]

  it('updates the sensor whose label the file names', () => {
    expect(planSensorImport([{ label: 'camera b', images: null }], sensors, images)[0])
      .toMatchObject({ target: 'B', reason: 'label' })
  })

  it('updates the sensor of exactly the listed images', () => {
    expect(planSensorImport([{ label: null, images: ['a.tif', 'b.tif'] }], sensors, images)[0])
      .toMatchObject({ target: 'A', reason: 'images', imageIds: [1, 2] })
  })

  it('makes a new sensor for a subset of a shared sensor, and reports unknown names', () => {
    expect(planSensorImport([{ label: null, images: ['a.tif', 'zz.tif'] }], sensors, images)[0])
      .toEqual({ target: null, reason: 'new', imageIds: [1], unmatched: ['zz.tif'] })
  })

  it('updates the only sensor in use from a single row without images', () => {
    const one = [{ id: 'A', label: 'Sensor 1' }]
    expect(planSensorImport([{ label: null, images: null }], one, images)[0]).toMatchObject({ target: 'A', reason: 'sole' })
    expect(planSensorImport([{ label: null, images: null }], sensors, images.slice(0, 2))[0]).toMatchObject({ target: 'A' })
  })

  it('makes new sensors when several rows have no label or images', () => {
    const plan = planSensorImport([{ label: null, images: null }, { label: null, images: null }], sensors, images)
    expect(plan.map((p) => p.target)).toEqual([null, null])
  })

  it('gives a lone new sensor the images that have none', () => {
    const p = { label: null, images: null }
    expect(sensorImportImageIds({ imageIds: [] }, p, null, 1, images)).toEqual([4])
    expect(sensorImportImageIds({ imageIds: [] }, p, 'A', 1, images)).toEqual([])
  })
})
