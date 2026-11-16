import { describe, it, expect } from 'vitest'
import { ocrConcurrency, compactLines, storedToLines, sharedCoords, textMaskPlan, MAX_TEXT_SHARE } from './textRun.js'
import { polyBounds } from './quad.js'

const rect = (x0, y0, x1, y1) => [
  [x0, y0],
  [x1, y0],
  [x1, y1],
  [x0, y1],
]
const line = (text, textScore, quad) => ({ quad, text, textScore, angle: 0 })

describe('ocrConcurrency', () => {
  it('fits as many jobs as the budget holds, within the pool and the photo count', () => {
    const GB = 1024 ** 3
    expect(ocrConcurrency(30, 7, 0.1 * GB)).toBe(1)
    expect(ocrConcurrency(30, 7, 64 * GB)).toBe(7)
    expect(ocrConcurrency(2, 7, 64 * GB)).toBe(2)
    const two = ocrConcurrency(30, 7, 2 * GB),
      four = ocrConcurrency(30, 7, 4 * GB)
    expect(four).toBeGreaterThan(two)
  })
})

describe('compactLines', () => {
  it('keeps only lines that may be text, rounded, and reads back in the rule shape', () => {
    const lines = [
      line('F31 USN', 0.9712, rect(10.04, 20.06, 100.01, 30)),
      line('Fa', 0.38, rect(0, 0, 5, 5)),
      line('', 0, rect(0, 0, 5, 5)),
    ]
    const stored = compactLines(lines)
    expect(stored).toEqual([{ quad: rect(10, 20.1, 100, 30), text: 'F31 USN', score: 0.97, angle: 0 }])
    expect(storedToLines(stored)[0]).toMatchObject({ text: 'F31 USN', textScore: 0.97 })
  })
})

describe('sharedCoords', () => {
  it('maps to fractions of the photo without a fiducial fit, and back', () => {
    const { film, fraction } = sharedCoords({}, null, 1000, 500)
    expect(film).toBeNull()
    expect(fraction.to([250, 100])).toEqual([0.25, 0.2])
    expect(fraction.from([0.25, 0.2])).toEqual([250, 100])
  })

  it('maps through the fiducials for a calibrated film camera', () => {
    // Four corner marks at ±100 mm; this scan has 20 px per mm, centred at (2100, 2100).
    const marks = [
      { id: 'a', xMm: -100, yMm: 100 },
      { id: 'b', xMm: 100, yMm: 100 },
      { id: 'c', xMm: 100, yMm: -100 },
      { id: 'd', xMm: -100, yMm: -100 },
    ]
    const slots = ['tl', 'tr', 'br', 'bl']
    const sensor = {
      kind: 'film',
      fiducialCalibration: { marks, slotMap: Object.fromEntries(slots.map((s, i) => [s, marks[i].id])) },
    }
    const px = (m) => ({ px: 2100 + m.xMm * 20, py: 2100 - m.yMm * 20 })
    const image = { fiducialDetections: slots.map((slot, i) => ({ slot, ...px(marks[i]) })) }
    const { film } = sharedCoords(image, sensor, 4200, 4200)
    expect(film).not.toBeNull()
    const mm = film.to([2100 + 0.5 + 50 * 20, 2100 + 0.5])
    expect(mm[0]).toBeCloseTo(50, 1)
    expect(mm[1]).toBeCloseTo(0, 1)
    const back = film.from(mm)
    expect(back[0]).toBeCloseTo(2100.5 + 1000, 6)
  })
})

describe('textMaskPlan', () => {
  const W = 1000,
    H = 1000
  // The camera's data strip at the right edge on frames a-d; read surely on a only, so
  // b and c offer it only as a candidate and d not at all. Frame b has a roof read as "T".
  const strip = (dx) => rect(950 + dx, 100, 970 + dx, 400)
  const frames = [
    { id: 'a', lines: [line('F31 USN GS T12A', 0.97, strip(0))] },
    { id: 'b', lines: [line('F3 USN', 0.6, strip(3)), line('T', 0.95, rect(300, 300, 310, 310))] },
    { id: 'c', lines: [line('USN GS', 0.7, strip(-2))] },
    { id: 'd', lines: [] },
  ].map((f) => ({ ...f, natW: W, natH: H, camera: 'cam', shared: sharedCoords({}, null, W, H) }))

  it('masks sure text alone without recurrence', () => {
    const plan = textMaskPlan(frames, { padPx: 0, recurring: false })
    expect(plan.get('a').polygons).toHaveLength(1)
    expect(plan.get('b').polygons).toHaveLength(0)
    expect(plan.get('d').polygons).toHaveLength(0)
  })

  it('masks recurring text on every frame of the camera, never the lone roof', () => {
    const plan = textMaskPlan(frames, { padPx: 10, recurring: true })
    for (const id of ['a', 'b', 'c', 'd']) {
      const p = plan.get(id)
      expect(p.recurring).toBe(1)
      const [x0, y0, x1, y1] = polyBounds(p.polygons.at(-1))
      expect(x0).toBeGreaterThan(930)
      expect(x1).toBeLessThan(990)
      expect(y0).toBeCloseTo(90, 6)
      expect(y1).toBeCloseTo(410, 6)
    }
    const b = plan.get('b').polygons
    expect(b.some((poly) => polyBounds(poly)[0] < 400)).toBe(false)
  })

  it('keeps cameras apart', () => {
    const mixed = frames.map((f, i) => ({ ...f, camera: i < 2 ? 'one' : 'two' }))
    const plan = textMaskPlan(mixed, { recurring: true })
    expect(plan.get('d').recurring).toBe(0)
  })

  it('skips a photo whose text would cover most of it', () => {
    const big = [{ ...frames[0], lines: [line('KODAK SAFETY FILM', 0.99, rect(0, 0, 1000, 800))] }]
    const p = textMaskPlan(big, { recurring: false }).get('a')
    expect(p.share).toBeGreaterThan(MAX_TEXT_SHARE)
    expect(p.skipped).toBe(true)
  })
})
