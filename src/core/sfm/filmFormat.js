// Film format width vs scan pixel pitch — the two ways the sensor table can turn a
// focal in mm into a focal in pixels, and the "implied film width" check between them.
//
// Pure. `resolveK` (reconstruction.js) owns the precedence and imports the two rules
// it shares with the sensor table from here (`scanWidthPx`, `usesFormatWidth`), so the
// table can show which value the solver will actually use without re-deriving it.
//
//   format path: fx = focalMm / formatMm × widthPx   (a declared format outranks…)
//   pitch path:  fx = focalMm / pitchMm              (…a scan pitch; widthPx × pitch is
//                                                     then the film width it implies)
//
// A format comes off a camera calibration certificate; a scan pitch is usually read
// off the scanner setting and is the value that goes wrong (the TMA set's 0.025 mm/px
// implies a 253 mm frame, which no aerial film has). The format is the right number
// only when the scan's pixel columns span exactly that width, i.e. the scan is cropped
// to the image frame; a scan that keeps the film margins spans more than the format.

// Widths (mm) a scan of aerial mapping film plausibly spans. `suggest` marks an IMAGE
// format the table may offer as a replacement value; the 240 mm entry is the full
// 9½-inch roll width (a scan that keeps the margins), accepted by the sanity check but
// never proposed as a format, since a format is the image frame, not the film strip.
export const AERIAL_FILM_WIDTHS = [
  { widthMm: 230, label: '9-inch aerial frame', suggest: true },
  { widthMm: 240, label: 'full 9½-inch roll width', suggest: false },
]

// An implied width within ±5 % of a known width is accepted silently.
export const KNOWN_WIDTH_TOLERANCE = 0.05
// A standard format is offered only within ±15 % of the implied width: that covers a
// wrong-by-a-few-percent scanner pitch (253 mm → 230 mm is 10 %); a larger gap is a
// different mistake (a halved pitch, a non-aerial format), and a guess would mislead.
export const SUGGEST_TOLERANCE = 0.15

const relGap = (mm, ref) => Math.abs(mm - ref) / ref

// True when a physical film width (mm) matches a known aerial width within ±5 %.
export function isKnownAerialFilmWidth(mm) {
  return Number.isFinite(mm) && AERIAL_FILM_WIDTHS.some((f) => relGap(mm, f.widthMm) <= KNOWN_WIDTH_TOLERANCE)
}

// The image width (px) resolveK scales a format by: the sensor's declared width,
// else the image's own, else 1000. Shared with resolveK so the two cannot disagree.
export function scanWidthPx(meta, sensor) {
  return sensor?.width || meta?.width || 1000
}

// True when resolveK takes the format path for this sensor: a focal in mm and a
// non-zero format width. (Path 0, a fitted fiducial frame, exists only inside a
// reconstruction run and outranks this; the table cannot see it.)
export function usesFormatWidth(sensor) {
  return sensor?.focal != null && sensor.focalUnit !== 'px' && !!sensor.sensorWidthMm
}

// The nearest suggestable format for an implied width, or null when the width is
// already a known one or no format lies within SUGGEST_TOLERANCE.
// Returns { widthMm, label, gapPct } (gapPct: |implied − format| / format, in %).
export function suggestFilmFormat(impliedMm) {
  if (!Number.isFinite(impliedMm) || impliedMm <= 0 || isKnownAerialFilmWidth(impliedMm)) return null
  let best = null
  for (const f of AERIAL_FILM_WIDTHS) {
    if (!f.suggest) continue
    const gap = relGap(impliedMm, f.widthMm)
    if (gap <= SUGGEST_TOLERANCE && (!best || gap < best.gap)) best = { f, gap }
  }
  return best ? { widthMm: best.f.widthMm, label: best.f.label, gapPct: best.gap * 100 } : null
}

const span = (xs) => (xs.length ? { min: Math.min(...xs), max: Math.max(...xs) } : null)

// What the sensor table should show for one sensor's format / pitch pair.
// `entries` is one `{ widthPx, K }` per assigned image (K = resolveK(meta, sensor),
// widthPx = scanWidthPx(meta, sensor)); pass a single probe for a sensor with none.
// Returns
//   { source: 'format', formatMm, pitchMm: {min,max}, ignoredPitchMm }  — pitch derived
//   { source: 'pitch', impliedMm: {min,max}, warnCount, total, suggestion }
//   { source: 'none' }                                                  — neither applies
// `suggestion` = { widthMm, label, gapPct, reason } only when every off-standard image
// points at the same format; mixed verdicts offer nothing rather than pick one.
export function filmFormatStatus(sensor, entries) {
  const list = (entries || []).filter((e) => e && Number.isFinite(e.widthPx) && e.widthPx > 0)
  if (usesFormatWidth(sensor)) {
    const formatMm = Number(sensor.sensorWidthMm)
    const pitches = [...new Set(list.map((e) => e.widthPx))].map((w) => formatMm / w)
    const pitchMm = span(pitches)
    // A stored pitch the format outranks: kept on the sensor (clearing the format
    // brings it back) but not used — say so rather than show it as if it were.
    const p = Number(sensor.pixelSize)
    const ignoredPitchMm = p > 0 && pitchMm && pitches.some((x) => relGap(p, x) > 0.005) ? p : null
    return { source: 'format', formatMm, pitchMm, ignoredPitchMm }
  }
  const implied = list.filter((e) => Number.isFinite(e.K?.impliedFilmWidthMm))
  if (!implied.length) return { source: 'none' }
  const off = implied.filter((e) => e.K.filmWidthOk === false)
  let suggestion = null
  if (off.length) {
    const picks = off.map((e) => suggestFilmFormat(e.K.impliedFilmWidthMm))
    const ids = new Set(picks.map((x) => x?.widthMm ?? null))
    if (ids.size === 1 && picks[0]) {
      const w = span(off.map((e) => e.K.impliedFilmWidthMm))
      const wText = w.min.toFixed(0) === w.max.toFixed(0) ? `${w.min.toFixed(0)} mm` : `${w.min.toFixed(0)}–${w.max.toFixed(0)} mm`
      const gaps = off.map((e) => relGap(e.K.impliedFilmWidthMm, picks[0].widthMm) * 100)
      suggestion = {
        ...picks[0],
        gapPct: Math.max(...gaps),
        reason: `pixel size ${sensor?.pixelSize} mm implies a ${wText} film width, not a standard aerial `
          + `format; nearest standard is the ${picks[0].label} (${picks[0].widthMm} mm, `
          + `${Math.max(...gaps).toFixed(1)}% away)`,
      }
    }
  }
  return {
    source: 'pitch',
    impliedMm: span(implied.map((e) => e.K.impliedFilmWidthMm)),
    warnCount: off.length,
    total: implied.length,
    suggestion,
  }
}
