import { unzlibSync } from 'fflate'
import { coreIo } from './coreIo.js'

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

// The grids in public/geoid/ (scripts/build-geoid-grids.mjs): N at every node, Int16
// centimetres, rows from 90° N, columns from 180° W, zlib. EGM96 at its own 15′, read
// bilinearly as PROJ does; EGM2008 at 5′ (every 2nd node of its 2.5′ grid, rows stored as
// differences along them), read bicubically: 4 mm RMS and 4 cm at p99.9 against the 2.5′
// grid, where 15′ nodes read bilinearly were 7 cm RMS and up to 2.5 m (docs/METHODS.md §9.1).
export const GEOID_GRIDS = {
  'geoid:EGM96': { file: 'egm96-15.i16.z', rows: 721, cols: 1440, step: 0.25 },
  'geoid:EGM2008': { file: 'egm2008-5.i16d.z', rows: 2161, cols: 4320, step: 1 / 12, delta: true, cubic: true },
}

export const isConvertible = (datum) => datum === 'ellipsoidal' || datum in GEOID_GRIDS

// Catmull–Rom through p1 (t = 0) and p2 (t = 1).
const catmullRom = (p0, p1, p2, p3, t) =>
  p1 + 0.5 * t * (p2 - p0 + t * (2 * p0 - 5 * p1 + 4 * p2 - p3 + t * (3 * (p1 - p2) + p3 - p0)))

// N(lon, lat) in metres between the nodes of a grid (`shape` as in GRIDS, EGM96's by
// default); longitude wraps, latitude clamps at the poles.
export function geoidGrid(cm, shape = GEOID_GRIDS['geoid:EGM96']) {
  const { rows, cols, step, cubic = false } = shape
  if (cm.length !== rows * cols) throw new Error(`A geoid grid has ${rows * cols} nodes, not ${cm.length}`)
  const at = (r, c) => cm[Math.min(rows - 1, Math.max(0, r)) * cols + (((c % cols) + cols) % cols)]
  return {
    undulation(lon, lat) {
      const x = ((((lon + 180) / step) % cols) + cols) % cols
      const y = Math.min(rows - 1, Math.max(0, (90 - lat) / step))
      const c0 = Math.floor(x),
        r0 = Math.min(rows - 2, Math.floor(y))
      const fx = x - c0,
        fy = y - r0
      if (cubic) {
        const row = (r) => catmullRom(at(r, c0 - 1), at(r, c0), at(r, c0 + 1), at(r, c0 + 2), fx)
        return catmullRom(row(r0 - 1), row(r0), row(r0 + 1), row(r0 + 2), fy) / 100
      }
      const top = at(r0, c0) * (1 - fx) + at(r0, c0 + 1) * fx
      const bottom = at(r0 + 1, c0) * (1 - fx) + at(r0 + 1, c0 + 1) * fx
      return (top * (1 - fy) + bottom * fy) / 100
    },
  }
}

// The stored bytes of a grid (decompressed) as its node values.
export function geoidNodes(bytes, shape) {
  const cm = new Int16Array(bytes.buffer, bytes.byteOffset, bytes.byteLength / 2)
  if (!shape.delta) return cm
  const out = Int16Array.from(cm)
  for (let i = 1; i < out.length; i++) if (i % shape.cols) out[i] += out[i - 1]
  return out
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
export function loadGeoid(datum, { fetchImpl = (...a) => coreIo().fetch(...a) } = {}) {
  const shape = GEOID_GRIDS[datum]
  if (!shape) return Promise.reject(new Error(`No geoid model for ${datum}`))
  if (!loaded.has(datum)) {
    const promise = (async () => {
      const res = await fetchImpl(`${geoidBaseUrl()}${shape.file}`)
      if (!res.ok) throw new Error(`The ${datumLabel(datum)} grid could not be loaded (HTTP ${res.status})`)
      return geoidGrid(geoidNodes(unzlibSync(new Uint8Array(await res.arrayBuffer())), shape), shape)
    })()
    loaded.set(datum, promise)
    promise.catch(() => loaded.delete(datum))
  }
  return loaded.get(datum)
}

// The grids a conversion between these datums needs, as datumShift takes them.
export async function loadGeoids(...datums) {
  const grids = {}
  for (const d of new Set(datums)) if (d in GEOID_GRIDS) grids[d] = await loadGeoid(d)
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
