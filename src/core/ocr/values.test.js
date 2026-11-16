import { describe, it, expect } from 'vitest'
import { parseLine, photoValues, voteValue } from './values.js'

const values = (text, name) =>
  parseLine(text, 1)
    .filter((r) => r.name === name)
    .map((r) => r.value)

// The lines are as PP-OCR read them on the test scans (TMA, Casa Grande, Iceland) and
// as hist_sfm's values.py lists them.
describe('parseLine: focal length', () => {
  it('reads a labelled or a unit focal length, fixing digit confusions', () => {
    expect(values('CAL F.L. 153.891', 'focal')).toEqual(['153.891'])
    expect(values('FL 152.87', 'focal')).toEqual(['152.87'])
    expect(values('151.982 mm', 'focal')).toEqual(['151.982'])
    expect(values('5l.92mm', 'focal')).toEqual([])
    expect(values('15l.92mm', 'focal')).toEqual(['151.92'])
  })

  it('reads a bare decimal only near a common lens, with a decimal comma too', () => {
    expect(values('152.86', 'focal')).toEqual(['152.86'])
    expect(values('UAGI 6056 151,78', 'focal')).toEqual(['151.78'])
    expect(values('85.23', 'focal')).toEqual([])
    expect(values('13,000', 'focal')).toEqual([])
    expect(values('215.47', 'focal')).toEqual([])
  })

  it('drops a reading cut off in front ("3.46 mm" of 153.46)', () => {
    expect(values('3.46 mm', 'focal')).toEqual([])
  })
})

describe('parseLine: date', () => {
  it('reads US month-day-year, and day first where the first number is no month', () => {
    expect(values('9-6-78', 'date')).toEqual(['1978-09-06'])
    expect(values('22-8.80', 'date')).toEqual(['1980-08-22'])
    expect(values('12/27/68', 'date')).toEqual(['1968-12-27'])
  })

  it('reads a month name and the end of a TMA data line', () => {
    expect(values('F32 M5120B 18 DEC 66', 'date')).toEqual(['1966-12-18'])
    expect(values('22 Feb.1947', 'date')).toEqual(['1947-02-22'])
    expect(values('F31 USN GS T 12A 13 12 27 68', 'date')).toEqual(['1968-12-27'])
  })

  it('reads no impossible date and no date without a year', () => {
    expect(values('2-30-68', 'date')).toEqual([])
    expect(values('12-27', 'date')).toEqual([])
    expect(values('1:25,000', 'date')).toEqual([])
  })
})

describe('voteValue', () => {
  it('lets the photos of a camera agree, one vote per photo', () => {
    const lines = (...texts) => texts.map((text) => ({ text, textScore: 0.95 }))
    const photos = [lines('152.86', 'ARIZ CSR-D'), lines('152.86', '152.86'), lines('152.66'), lines('9-6-78')].map(
      photoValues,
    )
    expect(voteValue(photos.map((p) => p.focal))).toEqual({ value: '152.86', photos: 2, of: 3, share: 2 / 3 })
    expect(voteValue(photos.map((p) => p.date))).toEqual({ value: '1978-09-06', photos: 1, of: 1, share: 1 })
    expect(voteValue([[], []])).toBeNull()
  })
})
