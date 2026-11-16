// Values printed on aerial photographs, from the text lines read on them (core/ocr/):
// the calibrated focal length and the date of the flight. A single reading is often
// incomplete or a little wrong, so the photos of one camera vote. A port of the focal
// length and date rules of hist_sfm's preparation/values.py, without its archive-specific
// parts (altitudes, positions and frame counters of the TMA data cards).
//
// Pure: lines in, values out.

// OCR confusions inside numbers.
const DIGITS = {
  'O': '0',
  'o': '0',
  'D': '0',
  'Q': '0',
  'I': '1',
  'l': '1',
  'L': '1',
  '|': '1',
  'i': '1',
  '!': '1',
  'Z': '2',
  'S': '5',
  's': '5',
  'B': '8',
  'G': '6',
  ':': '.',
  ',': '.',
  ';': '.',
}
const NUM = '[0-9OoDQIlL|i!ZSsBG:;,.]'
const toDigits = (s) => [...s].map((c) => DIGITS[c] ?? c).join('')

// A calibrated focal length lies in this range (mm): 88 mm super-wide-angle to the
// 610 mm of reconnaissance cameras.
export const FOCAL_RANGE = [80, 650]
// A bare number (no "mm", no "F.L.") counts only near a common lens: 6 in (152 mm),
// 8.25 in (210 mm), 12 in (305 mm) cameras and the 88 mm super-wide-angle, calibrated
// a few mm off ("85.23" on a TMA card is a latitude).
const BARE_FOCAL_BANDS = [
  [87, 90],
  [147, 158],
  [205, 215],
  [298, 310],
]
export const YEAR_RANGE = [1900, 2030]
const MONTHS = ['JAN', 'FEB', 'MAR', 'APR', 'MAY', 'JUN', 'JUL', 'AUG', 'SEP', 'OCT', 'NOV', 'DEC']

/** A focal length token as a value, or null: a decimal number within FOCAL_RANGE. */
function focal(token) {
  const v = toDigits(token).replace(/\.$/, '')
  if (!/^\d{2,3}\.\d{1,3}$/.test(v)) return null
  const n = Number(v)
  return n >= FOCAL_RANGE[0] && n <= FOCAL_RANGE[1] ? v : null
}

function isoDate(year, month, day) {
  // A two-digit year on an archive photograph is of the 1900s.
  if (year < 100) year += 1900
  if (year < YEAR_RANGE[0] || year > YEAR_RANGE[1]) return null
  if (!(month >= 1 && month <= 12 && day >= 1)) return null
  const d = new Date(Date.UTC(year, month - 1, day))
  if (d.getUTCMonth() !== month - 1) return null
  return `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`
}

/**
 * Every value one text line may carry: `[{ name: 'focal' | 'date', value, raw,
 * weight }]`, the weight the line's confidence, lowered for weaker forms. A focal
 * length is `"152.86"` (as printed, digits fixed); a date is ISO `YYYY-MM-DD`.
 */
export function parseLine(text, score) {
  const reads = []
  const upper = String(text ?? '').toUpperCase()
  // Focal length with its label: "CAL F.L. 153.891", "FL 152.87", "F.L.=152,86".
  const labelled = new RegExp(`(?:C\\.?\\s*A?\\.?\\s*L?\\.?\\s*)?F\\.?\\s*L\\.?\\s*[=:]?\\s*(${NUM}{4,8})`, 'g')
  for (const m of upper.matchAll(labelled)) {
    const v = focal(m[1])
    if (v) reads.push({ name: 'focal', value: v, raw: m[0], weight: score })
  }
  // With its unit: "151.982 mm", "153.46MM".
  for (const m of upper.matchAll(new RegExp(`(?<![A-Z0-9])(${NUM}{4,8})\\s*MM\\b`, 'g'))) {
    const v = focal(m[1])
    if (v && !reads.some((r) => r.value === v)) reads.push({ name: 'focal', value: v, raw: m[0], weight: score })
  }
  // A bare decimal near a common lens ("152.86" alone, "UAGI 6056 151,78"); not a
  // thousands group ("13,000") or a clock ("14:06").
  if (!reads.some((r) => r.name === 'focal'))
    for (const m of upper.matchAll(/(?<![\d/.,:-])(\d{2,3}[.,]\d{2,3})(?![\d/.,:-])/g)) {
      if (/^\d{1,3},\d{3}$/.test(m[1])) continue
      const v = focal(m[1])
      const n = Number(v)
      if (v && BARE_FOCAL_BANDS.some(([lo, hi]) => n >= lo && n <= hi))
        reads.push({ name: 'focal', value: v, raw: m[0], weight: score * 0.7 })
    }
  // Dates: "18 DEC 66", "22 FEB.1947"; "9-6-78", "12/27/68", "22-8.80" (day first when
  // the first number cannot be a month, else month first, as on US frames).
  for (const m of upper.matchAll(
    new RegExp(`(\\d{1,2})\\s*(${MONTHS.join('|')})[A-Z]*[\\s.,]*(\\d{4}|\\d{2})(?!\\d)`, 'g'),
  )) {
    const v = isoDate(Number(m[3]), MONTHS.indexOf(m[2]) + 1, Number(m[1]))
    if (v) reads.push({ name: 'date', value: v, raw: m[0], weight: score })
  }
  for (const m of upper.matchAll(/(?<![\d.])(\d{1,2})[-./](\d{1,2})[-./](\d{4}|\d{2})(?![-./]?\d)/g)) {
    const a = Number(m[1]),
      b = Number(m[2])
    const [month, day] = a > 12 && b <= 12 ? [b, a] : [a, b]
    const v = isoDate(Number(m[3]), month, day)
    if (v) reads.push({ name: 'date', value: v, raw: m[0], weight: score * (a <= 12 && b <= 12 ? 0.8 : 1) })
  }
  // The end of a TMA data line, month day year apart: "F31 USN GS T 12A 13 12 27 68".
  const tail = upper.match(/(?<![\d.])(\d{1,2}) (\d{1,2}) (\d{2})\s*$/)
  if (tail && !reads.some((r) => r.name === 'date')) {
    const v = isoDate(Number(tail[3]), Number(tail[1]), Number(tail[2]))
    if (v) reads.push({ name: 'date', value: v, raw: tail[0], weight: score * 0.7 })
  }
  return reads
}

/** The values on one photo's lines: `{ focal: [read], date: [read] }`. */
export function photoValues(lines) {
  const out = { focal: [], date: [] }
  for (const l of lines) for (const r of parseLine(l.text, l.textScore ?? l.score ?? 0)) out[r.name].push(r)
  return out
}

/**
 * The value the photos agree on: each photo votes once per value it shows (its best
 * reading's weight), the heaviest value wins. `perPhoto` is `[[read]]`, one list per
 * photo. Returns `{ value, photos, of, share }` (photos showing the winner, photos with
 * any reading of this kind), or null when none has one.
 */
export function voteValue(perPhoto) {
  const weight = new Map(),
    photos = new Map()
  let of = 0
  for (const reads of perPhoto) {
    if (!reads.length) continue
    of++
    const best = new Map()
    for (const r of reads) best.set(r.value, Math.max(best.get(r.value) ?? 0, r.weight))
    for (const [v, w] of best) {
      weight.set(v, (weight.get(v) ?? 0) + w)
      photos.set(v, (photos.get(v) ?? 0) + 1)
    }
  }
  if (!of) return null
  let value = null
  for (const [v, w] of weight) if (value == null || w > weight.get(value)) value = v
  return { value, photos: photos.get(value), of, share: photos.get(value) / of }
}
