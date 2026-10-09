import { describe, it, expect } from 'vitest'
import {
  isKnownAerialFilmWidth, suggestFilmFormat, filmFormatStatus, scanWidthPx, usesFormatWidth,
} from './filmFormat.js'
import { resolveK } from './reconstruction.js'

// One { widthPx, K } entry per image, built exactly as the sensor table builds them.
const entriesFor = (sensor, metas) =>
  metas.map((meta) => ({ widthPx: scanWidthPx(meta, sensor), K: resolveK(meta, sensor) }))

describe('isKnownAerialFilmWidth', () => {
  it('accepts 230 and 240 mm within ±5 %, rejects the rest', () => {
    expect(isKnownAerialFilmWidth(230)).toBe(true)
    expect(isKnownAerialFilmWidth(241)).toBe(true)
    expect(isKnownAerialFilmWidth(253.4)).toBe(false)
    expect(isKnownAerialFilmWidth(36)).toBe(false)
    expect(isKnownAerialFilmWidth(NaN)).toBe(false)
  })
})

describe('suggestFilmFormat', () => {
  it('suggests 230 mm for the TMA set’s implied 253 mm (FID-08)', () => {
    const s = suggestFilmFormat(10137 * 0.025)
    expect(s.widthMm).toBe(230)
    expect(s.gapPct).toBeCloseTo(10.2, 1)
  })

  it('never proposes the 240 mm roll width as a format, even when it is nearer', () => {
    // 253 mm is 5.4 % from 240 and 10 % from 230: the image format is still 230.
    expect(suggestFilmFormat(253).widthMm).toBe(230)
  })

  it('offers nothing for an already-known width', () => {
    expect(suggestFilmFormat(231)).toBeNull()
    expect(suggestFilmFormat(240)).toBeNull()
  })

  it('offers nothing outside the ±15 % tolerance (a different mistake, not a pitch slip)', () => {
    expect(suggestFilmFormat(126.7)).toBeNull() // a halved pitch on a 253 mm scan
    expect(suggestFilmFormat(36)).toBeNull()    // a full-frame digital sensor
    expect(suggestFilmFormat(264)).not.toBeNull()
    expect(suggestFilmFormat(266)).toBeNull()
  })

  it('rejects non-finite or non-positive input', () => {
    expect(suggestFilmFormat(null)).toBeNull()
    expect(suggestFilmFormat(0)).toBeNull()
    expect(suggestFilmFormat(-230)).toBeNull()
  })
})

describe('scanWidthPx / usesFormatWidth mirror resolveK', () => {
  it('prefers the sensor width, then the image width, then 1000', () => {
    expect(scanWidthPx({ width: 9000 }, { width: 10137 })).toBe(10137)
    expect(scanWidthPx({ width: 9000 }, { width: null })).toBe(9000)
    expect(scanWidthPx(null, null)).toBe(1000)
  })

  it('takes the format path only for an mm focal with a non-zero format', () => {
    expect(usesFormatWidth({ focal: 152, focalUnit: 'mm', sensorWidthMm: 230 })).toBe(true)
    expect(usesFormatWidth({ focal: 152, focalUnit: 'px', sensorWidthMm: 230 })).toBe(false)
    expect(usesFormatWidth({ focal: null, focalUnit: 'mm', sensorWidthMm: 230 })).toBe(false)
    expect(usesFormatWidth({ focal: 152, focalUnit: 'mm', sensorWidthMm: 0 })).toBe(false)
    expect(usesFormatWidth({ focal: 152, focalUnit: 'mm', sensorWidthMm: null })).toBe(false)
  })
})

describe('filmFormatStatus', () => {
  const meta = { width: 10137, height: 9600 }

  it('pitch path off-standard: reports the implied width and suggests 230 mm', () => {
    const sensor = { width: 10137, focal: 154, focalUnit: 'mm', pixelSize: 0.025, kind: 'film' }
    const st = filmFormatStatus(sensor, entriesFor(sensor, [meta, meta]))
    expect(st.source).toBe('pitch')
    expect(st.impliedMm.min).toBeCloseTo(253.4, 1)
    expect(st.warnCount).toBe(2)
    expect(st.total).toBe(2)
    expect(st.suggestion.widthMm).toBe(230)
    expect(st.suggestion.reason).toMatch(/0\.025 mm implies a 253 mm film width/)
    expect(st.suggestion.reason).toMatch(/230 mm/)
  })

  it('applying the suggestion moves resolveK to the format path and clears the warning', () => {
    const sensor = { width: 10137, focal: 154, focalUnit: 'mm', pixelSize: 0.025, kind: 'film' }
    const before = filmFormatStatus(sensor, entriesFor(sensor, [meta]))
    const applied = { ...sensor, sensorWidthMm: before.suggestion.widthMm }
    const K = resolveK(meta, applied)
    expect(K.source).toMatch(/230mm format/)
    expect(K.fx).toBeCloseTo((154 / 230) * 10137, 6)
    expect(K.filmWidthOk).toBeUndefined()
    const after = filmFormatStatus(applied, entriesFor(applied, [meta]))
    expect(after.source).toBe('format')
    expect(after.pitchMm.min).toBeCloseTo(230 / 10137, 9)
    // The stored 0.025 mm pitch is kept but outranked — reported, not silently shown.
    expect(after.ignoredPitchMm).toBe(0.025)
  })

  it('a standard implied width warns nothing and suggests nothing', () => {
    const sensor = { width: 10137, focal: 152, focalUnit: 'mm', pixelSize: 230 / 10137 }
    const st = filmFormatStatus(sensor, entriesFor(sensor, [meta]))
    expect(st.source).toBe('pitch')
    expect(st.warnCount).toBe(0)
    expect(st.suggestion).toBeNull()
  })

  it('derives one pitch per distinct scan width when the sensor declares none', () => {
    const sensor = { width: null, focal: 152, focalUnit: 'mm', sensorWidthMm: 230 }
    const st = filmFormatStatus(sensor, entriesFor(sensor, [{ width: 10000 }, { width: 10200 }, { width: 10000 }]))
    expect(st.source).toBe('format')
    expect(st.pitchMm.min).toBeCloseTo(230 / 10200, 12)
    expect(st.pitchMm.max).toBeCloseTo(230 / 10000, 12)
    expect(st.ignoredPitchMm).toBeNull()
  })

  it('a matching stored pitch is not reported as ignored', () => {
    const sensor = { width: 10000, focal: 152, focalUnit: 'mm', sensorWidthMm: 230, pixelSize: 0.023 }
    expect(filmFormatStatus(sensor, entriesFor(sensor, [{ width: 10000 }])).ignoredPitchMm).toBeNull()
  })

  it('mixed verdicts across scans offer no single suggestion', () => {
    // No sensor width: one scan implies 253 mm (→ 230), another 126 mm (no format).
    const sensor = { width: null, focal: 154, focalUnit: 'mm', pixelSize: 0.025 }
    const st = filmFormatStatus(sensor, entriesFor(sensor, [{ width: 10137 }, { width: 5050 }]))
    expect(st.warnCount).toBe(2)
    expect(st.suggestion).toBeNull()
  })

  it('a px focal or a sensor with no scale reports none', () => {
    const px = { width: 10137, focal: 6758, focalUnit: 'px', pixelSize: 0.025, sensorWidthMm: 230 }
    expect(filmFormatStatus(px, entriesFor(px, [meta])).source).toBe('none')
    const bare = { width: 10137, focal: 154, focalUnit: 'mm' }
    expect(filmFormatStatus(bare, entriesFor(bare, [meta])).source).toBe('none')
  })
})
