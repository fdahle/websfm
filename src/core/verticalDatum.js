import { unzlibSync } from 'fflate'

// Vertical datums of heights — GCPs, reference DEMs, computed products — and the
// geoid separation between them. An ellipsoidal height h and an orthometric
// (geoid) height H at the same point differ by the geoid undulation N there:
// h = H + N. N runs from −107 m to +86 m worldwide and −60 m to +20 m over
// Antarctica, so mixing the two is a systematic error the size of a building.
//
// Only ellipsoidal heights and the two global geoid models can be converted; a
// national height system ("orthometric": NAVD88, DHHN2016 …) or a local datum is
// declared for the record but never converted.
export const VERTICAL_DATUMS = [
  { id: 'ellipsoidal', label: 'Ellipsoidal (WGS 84)' },
  { id: 'geoid:EGM2008', label: 'Geoid EGM2008' },
  { id: 'geoid:EGM96', label: 'Geoid EGM96' },
  { id: 'orthometric', label: 'Other geoid / national' },
  { id: 'local', label: 'Local' },
  { id: 'unknown', label: 'Unknown' },
]
const DATUM_IDS = new Set(VERTICAL_DATUMS.map((d) => d.id))
export const isVerticalDatum = (id) => DATUM_IDS.has(id)
export const datumLabel = (id) => VERTICAL_DATUMS.find((d) => d.id === id)?.label ?? id ?? 'Unknown'

// The grids in public/geoid/ (scripts/build-geoid-grids.mjs): N at every 15′ node,
// 721 rows from 90° N, 1440 columns from 180° W, Int16 centimetres, zlib.
const GRID_FILES = { 'geoid:EGM96': 'egm96-15.i16.z', 'geoid:EGM2008': 'egm2008-15.i16.z' }
const ROWS = 721,
  COLS = 1440,
  STEP = 0.25

export const isConvertible = (datum) => datum === 'ellipsoidal' || datum in GRID_FILES

// N(lon, lat) in metres, bilinear between the 15′ nodes; longitude wraps.
export function geoidGrid(cm) {
  if (cm.length !== ROWS * COLS) throw new Error(`A geoid grid has ${ROWS * COLS} nodes, not ${cm.length}`)
  return {
    undulation(lon, lat) {
      const x = ((((lon + 180) / STEP) % COLS) + COLS) % COLS
      const y = Math.min(ROWS - 1, Math.max(0, (90 - lat) / STEP))
      const c0 = Math.floor(x),
        r0 = Math.min(ROWS - 2, Math.floor(y))
      const c1 = (c0 + 1) % COLS,
        fx = x - c0,
        fy = y - r0
      const at = (r, c) => cm[r * COLS + c]
      const top = at(r0, c0) * (1 - fx) + at(r0, c1) * fx
      const bottom = at(r0 + 1, c0) * (1 - fx) + at(r0 + 1, c1) * fx
      return (top * (1 - fy) + bottom * fy) / 100
    },
  }
}

/**
 * What to add to a height in datum `from` to express it in `to`, at lon/lat
 * (degrees, WGS 84): N_from − N_to with N = 0 for ellipsoidal heights. Zero when
 * the datums are the same, null when either cannot be converted. `grids` maps each
 * geoid datum involved to its geoidGrid (loadGeoids).
 */
export function datumShift(from, to, lon, lat, grids) {
  if (from === to) return 0
  if (!isConvertible(from) || !isConvertible(to)) return null
  const n = (d) => (d === 'ellipsoidal' ? 0 : grids[d].undulation(lon, lat))
  return n(from) - n(to)
}

function geoidBaseUrl() {
  const env = (typeof import.meta !== 'undefined' && import.meta.env) || {}
  return `${env.BASE_URL || '/'}geoid/`
}

// Fetched once per session; the service worker precaches the files (vite.config.js).
const loaded = new Map()
export function loadGeoid(datum, { fetchImpl = (...a) => fetch(...a) } = {}) {
  if (!(datum in GRID_FILES)) return Promise.reject(new Error(`No geoid model for ${datum}`))
  if (!loaded.has(datum)) {
    const promise = (async () => {
      const res = await fetchImpl(`${geoidBaseUrl()}${GRID_FILES[datum]}`)
      if (!res.ok) throw new Error(`The ${datumLabel(datum)} grid could not be loaded (HTTP ${res.status})`)
      const bytes = unzlibSync(new Uint8Array(await res.arrayBuffer()))
      return geoidGrid(new Int16Array(bytes.buffer, bytes.byteOffset, bytes.byteLength / 2))
    })()
    loaded.set(datum, promise)
    promise.catch(() => loaded.delete(datum))
  }
  return loaded.get(datum)
}

// The grids a conversion between these datums needs, as datumShift takes them.
export async function loadGeoids(...datums) {
  const grids = {}
  for (const d of new Set(datums)) if (d in GRID_FILES) grids[d] = await loadGeoid(d)
  return grids
}

/**
 * A converter from `from` to `to` for many points: (lon, lat) → shift in metres.
 * Null when the datums cannot be converted; the identity shift when they agree.
 */
export async function heightShifter(from, to) {
  if (from === to) return () => 0
  if (!isConvertible(from) || !isConvertible(to)) return null
  const grids = await loadGeoids(from, to)
  return (lon, lat) => datumShift(from, to, lon, lat, grids)
}

// "+53.38 m" or "+52.10 to +53.38 m": the shift a conversion added, for reports.
export function shiftRange({ min, max }) {
  const f = (v) => `${v >= 0 ? '+' : '−'}${Math.abs(v).toFixed(2)}`
  return f(min) === f(max) ? `${f(min)} m` : `${f(min)} to ${f(max)} m`
}
