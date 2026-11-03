// Reflectance map (plan-after-0.7 ▸ MSP-4; core/products/reflectanceMap.js): the panels'
// radiance, then the map in blocks over the pool. One worker holds the GeoTIFF writer
// (reflectanceBegin / Add / Finish); the others each render a run of blocks
// (reflectanceShare) and send them back as events, which the page passes to the writer,
// as the split orthophoto does (stores/reconstruction/reflectanceRun.js).
import { fromArrayBuffer } from 'geotiff'
import { frameFromSpec } from '../../core/products/frameSpec.js'
import { makeSampleMap } from '../../core/sfm/displayFrame.js'
import {
  reflectanceGeometry,
  demHeightAt,
  radiometryOf,
  blockCaptures,
  renderReflectanceBlock,
  nativeGsd,
} from '../../core/products/reflectanceMap.js'
import { radianceImage, regionStats } from '../../core/radiometry/micasense.js'
import { createCogBuilder, geoKeysForEpsg, crsTagInfo, gdalBandNames } from '../../core/products/geotiff.js'
import { deflateTile } from '../deflateTile.js'

export const REFLECTANCE_BLOCK = 1024
const TILE = 256
// The grid's longest side: past it the cell grows (and the log says so).
const MAX_SIDE = 60000

// A band photo's raw DN plane, from the original file.
async function readRaw(url) {
  const buf = await (await fetch(url)).arrayBuffer()
  const image = await (await fromArrayBuffer(buf)).getImage()
  const [dn] = await image.readRasters()
  return { dn, width: image.getWidth(), height: image.getHeight() }
}

// What every worker derives the same way from the input: the frame, the grid, the
// captures with their photos, and a cell → SfM point function.
function setup(input) {
  const { dem, bands, photos, refBand } = input
  const frame = frameFromSpec(dem.frame)
  // Auto: the reference band's own ground pixel (never finer than a 20th of the DEM's).
  let gsd = input.gsd > 0 ? input.gsd : 0
  let native = null
  if (!gsd) {
    const ref = photos.filter((p) => p.band === refBand)
    native = nativeGsd(
      dem,
      ref.map((p) => frame.fromSfm(centreOf(p))),
      ref.map((p) => p.K.fx),
    )
    gsd = Math.max(native ?? dem.gsd, dem.gsd / 20)
  }
  const span = Math.max(dem.width, dem.height) * dem.gsd
  const requested = gsd
  if (span / gsd > MAX_SIDE) gsd = span / MAX_SIDE
  const geom = reflectanceGeometry(dem, gsd)
  const built = photos.map((p) => ({
    ...p,
    sampleMap: makeSampleMap({ K: p.K, dist: p.dist, selfCal: p.selfCal }),
    cal: radiometryOf(p.meta.band, p.meta.model, p.factor, p.width, p.height),
  }))
  const byCapture = new Map()
  for (const p of built) {
    if (!byCapture.has(p.capture)) byCapture.set(p.capture, { photos: new Array(bands.length).fill(null) })
    byCapture.get(p.capture).photos[p.band] = p
  }
  const captures = []
  for (const cap of byCapture.values()) {
    cap.scoring = cap.photos[refBand] ?? cap.photos.find(Boolean)
    captures.push(cap)
  }
  const cellP = (c, r) => {
    const x = geom.originX + (c + 0.5) * geom.gsd,
      y = geom.originY - (r + 0.5) * geom.gsd
    const z = demHeightAt(dem, x, y)
    return Number.isFinite(z) ? frame.toSfm([x, y, z]) : null
  }
  const across = Math.ceil(geom.width / REFLECTANCE_BLOCK)
  const nBlocks = across * Math.ceil(geom.height / REFLECTANCE_BLOCK)
  const blockAt = (k) => {
    const col0 = (k % across) * REFLECTANCE_BLOCK,
      row0 = Math.floor(k / across) * REFLECTANCE_BLOCK
    return {
      col0,
      row0,
      width: Math.min(REFLECTANCE_BLOCK, geom.width - col0),
      height: Math.min(REFLECTANCE_BLOCK, geom.height - row0),
    }
  }
  return { frame, geom, captures, cellP, nBlocks, blockAt, native, requested }
}

const centreOf = ({ R, t }) => [0, 1, 2].map((i) => -(R[0][i] * t[0] + R[1][i] * t[1] + R[2][i] * t[2]))

export function makeReflectanceOps() {
  // The calibration panel's radiance per band: [{ key, url, band, model, corners }] →
  // { [key]: { radiance (mean over the band's panel photos), photos } }.
  async function reflectancePanels([{ panels }], { emit }) {
    const out = {}
    let done = 0
    for (const p of panels) {
      emit('progress', [done++, panels.length, 'Reading the calibration panel…'])
      try {
        const { dn, width, height } = await readRaw(p.url)
        const L = radianceImage(dn, width, height, p.band, p.model)
        const s = regionStats(L, width, p.corners)
        if (!(s.count > 0 && s.mean > 0)) continue
        const o = (out[p.key] ??= { sum: 0, photos: 0 })
        o.sum += s.mean
        o.photos++
      } catch (err) {
        emit('log', [
          `Reflectance map: could not read the panel photo ${p.name} — ${err?.message ?? err}`,
          'warn',
          'Products',
        ])
      }
    }
    for (const o of Object.values(out)) o.radiance = o.sum / o.photos
    return out
  }

  // The writer, on one worker: opens the GeoTIFF and returns the grid's plan.
  let writer = null
  async function reflectanceBegin([input], { emit }) {
    const s = setup(input)
    if (s.native != null)
      emit('log', [
        `Reflectance map: the reference band's ground pixel is ${s.native.toPrecision(3)} ${s.frame.unit ?? 'units'}`,
        'info',
        'Products',
      ])
    if (s.geom.gsd > s.requested * (1 + 1e-9))
      emit('log', [
        `Reflectance map: ${s.requested.toPrecision(3)} would need more than ${MAX_SIDE.toLocaleString()} cells a side; ` +
          `built at ${s.geom.gsd.toPrecision(3)}`,
        'warn',
        'Products',
      ])
    const tags = crsTagInfo({ crs: s.frame.crs, unit: s.frame.unit })
    writer = createCogBuilder(
      {
        width: s.geom.width,
        height: s.geom.height,
        tileSize: TILE,
        ArrayType: Float32Array,
        samples: input.bands.map(() => ({ bits: 32, format: 3 })),
        photometric: 1,
        gdalNoData: 'nan',
        gdalMetadata: gdalBandNames(input.bands.map((b) => b.name)),
        pixelScale: [s.geom.gsd, s.geom.gsd, 0],
        tiepoint: [0, 0, 0, s.geom.originX, s.geom.originY, 0],
        geoKeys: geoKeysForEpsg(tags.code, tags.geographic),
      },
      { blockSize: REFLECTANCE_BLOCK, compress: deflateTile },
    )
    return {
      width: s.geom.width,
      height: s.geom.height,
      gsd: s.geom.gsd,
      blocks: s.nBlocks,
      captures: s.captures.length,
      crs: s.frame.crs ?? null,
      unit: s.frame.unit ?? null,
    }
  }
  async function reflectanceAdd([b]) {
    if (!writer) throw new Error('reflectanceAdd: no reflectance map in progress on this worker')
    await writer.addBlock(b)
  }
  async function reflectanceFinish() {
    if (!writer) throw new Error('reflectanceFinish: no reflectance map in progress on this worker')
    const { parts } = await writer.finish()
    writer = null
    return { cog: new Blob(parts, { type: 'image/tiff' }) }
  }

  // Render blocks `ids`, each sent back as a 'block' event (its data transferred). Photos
  // stay loaded while the next blocks need them, within `cacheBytes`.
  async function reflectanceShare([input, ids], { emit }) {
    const s = setup(input)
    const nBands = input.bands.length
    const cache = new Map() // url → { dn, width, height, bytes }
    let cached = 0
    const cacheBytes = input.cacheBytes > 0 ? input.cacheBytes : 512 * 2 ** 20
    let covered = 0,
      loads = 0
    for (const [k, id] of ids.entries()) {
      const block = s.blockAt(id)
      const caps = blockCaptures(s.captures, block, s.cellP)
      const need = new Set()
      for (const cap of caps) for (const p of cap.photos) if (p) need.add(p.url)
      // Make room: drop photos this block does not need, oldest first.
      for (const [url, e] of cache) {
        if (cached <= cacheBytes) break
        if (need.has(url)) continue
        cache.delete(url)
        cached -= e.bytes
      }
      for (const url of need) {
        if (cache.has(url)) {
          const e = cache.get(url)
          cache.delete(url)
          cache.set(url, e) // most recent last
          continue
        }
        const e = await readRaw(url)
        e.bytes = e.dn.byteLength
        cache.set(url, e)
        cached += e.bytes
        loads++
      }
      const res = renderReflectanceBlock(block, caps, nBands, s.cellP, (p) => cache.get(p.url))
      covered += res.covered
      emit('block', [{ ...block, data: res.data }], [res.data.buffer])
      emit('progress', [k + 1, ids.length])
    }
    return { covered, loads }
  }

  return { reflectancePanels, reflectanceBegin, reflectanceAdd, reflectanceFinish, reflectanceShare }
}
