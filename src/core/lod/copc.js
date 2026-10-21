// A COPC file (Cloud Optimized Point Cloud, copc.io) read in place as a cloud source
// (core/lod/cloudSource.js): a LAZ 1.4 file whose points are already stored as a
// level-of-detail octree, so it needs no octree of ours. Pure: the file is injected
// I/O ({ size, read(start, end) → Uint8Array }, utils/blobParts.js blobSource), and
// so is the LASzip codec's chunk decoder:
//   createChunkDecoder(lazVlr) → { decode(compressed, numPoints) → records, free() }
//
// The layout (copc.io, COPC 1.0):
// - the first VLR ("copc", record 1, 160 bytes) gives the root cube (centre and
//   half size), the root's point spacing and where the root hierarchy page is;
// - a hierarchy page is a run of 32-byte entries (key d, x, y, z as Int32; offset
//   Uint64; byte size Int32; point count Int32). A count of -1 means the node's own
//   entry is in another page, at that offset; 0 an empty node that has children;
// - every node's points are one LASzip chunk of point format 6, 7 or 8.
// Its octree has the same keys and the same scheme as ours (every point in exactly one
// node; a parent is a subsample of its cube), so the readers' callers cannot tell them
// apart. Hierarchy pages are read as the view reaches them (`hierarchy: 'lazy'`) or all
// at once for the tools that walk every node.

import { readLasHeader, createLasDecoder } from '../io/las.js'
import { LASZIP_VLR_USER_ID, LASZIP_VLR_RECORD_ID } from '../io/laz.js'
import { STREAM_ATTRIBUTES, streamAttributes } from '../io/lasStream.js'
import { keyString, childKey, nodeCube, GRID } from './octree.js'
import { LOD_MIN_POINTS } from './build.js'

export const COPC_USER_ID = 'copc'
export const COPC_INFO_RECORD = 1
const ENTRY = 32
const COPC_FORMATS = new Set([6, 7, 8])
const RGB_OFFSET = { 7: 30, 8: 30 }
export const COPC_STATS_POINTS = 2_000_000 // points read at import for the styling statistics
// A COPC file this big is read in place; a smaller one imports into memory like any
// LAZ (all tools work on it there), unless it is too large to hold.
export const COPC_IN_PLACE_MIN_POINTS = LOD_MIN_POINTS

const toBase64 = (u8) => {
  let s = ''
  for (let i = 0; i < u8.length; i += 0x8000) s += String.fromCharCode(...u8.subarray(i, i + 0x8000))
  return btoa(s)
}
const fromBase64 = (s) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0))

/** The COPC info VLR of a header (core/io/las.js readLasHeader), or null when it is no COPC file. */
export function readCopcInfo(header) {
  const v = header.vlrs?.[0]
  if (!v || v.userId !== COPC_USER_ID || v.recordId !== COPC_INFO_RECORD || v.data.length < 160) return null
  const dv = new DataView(v.data.buffer, v.data.byteOffset, v.data.byteLength)
  const f = (o) => dv.getFloat64(o, true),
    u = (o) => Number(dv.getBigUint64(o, true))
  return {
    center: [f(0), f(8), f(16)],
    halfsize: f(24),
    spacing: f(32),
    rootPage: { offset: u(40), length: u(48) },
    gpsTime: [f(56), f(64)],
  }
}

/**
 * Whether a dropped LAS/LAZ is a COPC file to read in place: a COPC file of at least
 * `minPoints` points (a smaller one imports into memory like any LAZ, where every tool
 * works on it). `head`: the file's first bytes, up to the point data.
 * → true | false, or null when the header is unreadable
 */
export function copcReadsInPlace(head, { minPoints = 0 } = {}) {
  let h
  try {
    h = readLasHeader(head)
  } catch {
    return null
  }
  return !!readCopcInfo(h) && h.count >= minPoints
}

/** Entries of one hierarchy page: [{ key, offset, length, count }] (count -1: a page). */
export function parseHierarchyPage(bytes) {
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  const out = []
  for (let o = 0; o + ENTRY <= bytes.byteLength; o += ENTRY) {
    out.push({
      key: [dv.getInt32(o, true), dv.getInt32(o + 4, true), dv.getInt32(o + 8, true), dv.getInt32(o + 12, true)],
      offset: Number(dv.getBigUint64(o + 16, true)),
      length: dv.getInt32(o + 24, true),
      count: dv.getInt32(o + 28, true),
    })
  }
  return out
}

// ── CRS ──────────────────────────────────────────────────────────────────────

// WKT (1 or 2) as a tree of { name, args: [string | number | node] }.
function parseWkt(text) {
  let i = 0
  const ws = () => {
    while (i < text.length && /\s/.test(text[i])) i++
  }
  function value() {
    ws()
    if (text[i] === '"') {
      let s = ''
      for (i++; i < text.length; i++) {
        if (text[i] === '"') {
          if (text[i + 1] === '"') {
            s += '"'
            i++
            continue
          }
          i++
          break
        }
        s += text[i]
      }
      return s
    }
    const m = /^[A-Za-z_][A-Za-z0-9_]*/.exec(text.slice(i))
    if (m) {
      i += m[0].length
      ws()
      if (text[i] === '[' || text[i] === '(') {
        i++
        const args = []
        for (;;) {
          ws()
          if (text[i] === ']' || text[i] === ')') {
            i++
            break
          }
          args.push(value())
          ws()
          if (text[i] === ',') i++
          else if (text[i] !== ']' && text[i] !== ')') break
        }
        return { name: m[0].toUpperCase(), args }
      }
      return m[0]
    }
    const n = /^[-+0-9.eE]+/.exec(text.slice(i))
    if (n) {
      i += n[0].length
      return Number(n[0])
    }
    i = text.length
    return null
  }
  return value()
}

const HORIZONTAL = new Set([
  'PROJCS',
  'GEOGCS',
  'GEOCCS',
  'PROJCRS',
  'PROJECTEDCRS',
  'GEOGCRS',
  'GEOGRAPHICCRS',
  'GEODCRS',
  'GEODETICCRS',
  'BASEGEOGCRS',
])

/**
 * The horizontal CRS of an OGC WKT string: { name, epsg: 'EPSG:n' | null }, or null.
 * A compound CRS gives its first (horizontal) part.
 */
export function crsFromWkt(wkt) {
  let node
  try {
    node = parseWkt(String(wkt).replace(/\0+$/, ''))
  } catch {
    return null
  }
  if (!node?.name) return null
  if (node.name === 'COMPD_CS' || node.name === 'COMPOUNDCRS')
    node = node.args.find((a) => a?.name && HORIZONTAL.has(a.name)) ?? null
  if (!node || !HORIZONTAL.has(node.name)) return null
  const auth = node.args.find(
    (a) => (a?.name === 'AUTHORITY' || a?.name === 'ID') && String(a.args[0]).toUpperCase() === 'EPSG',
  )
  const code = auth ? Number(auth.args[1]) : NaN
  return {
    name: typeof node.args[0] === 'string' ? node.args[0] : null,
    epsg: Number.isInteger(code) && code > 0 ? `EPSG:${code}` : null,
  }
}

/** The horizontal EPSG code of a GeoKeyDirectory VLR payload (LASF_Projection 34735), or null. */
export function crsFromGeoKeys(data) {
  if (!data || data.length < 8) return null
  const dv = new DataView(data.buffer, data.byteOffset, data.byteLength)
  const n = dv.getUint16(6, true)
  let projected = null,
    geographic = null
  for (let k = 0; k < n && 8 + 8 * k + 8 <= data.length; k++) {
    const o = 8 + 8 * k
    const id = dv.getUint16(o, true),
      loc = dv.getUint16(o + 2, true),
      value = dv.getUint16(o + 6, true)
    if (loc !== 0 || value === 0 || value === 32767) continue
    if (id === 3072) projected = value
    if (id === 2048) geographic = value
  }
  const code = projected ?? geographic
  return code ? { name: null, epsg: `EPSG:${code}` } : null
}

/** The CRS a LAS file's projection records declare: the WKT first, else the GeoKeys. */
export function crsFromVlrs(vlrs = []) {
  const wkt = vlrs.find((v) => v.userId === 'LASF_Projection' && v.recordId === 2112)
  if (wkt) {
    const crs = crsFromWkt(new TextDecoder().decode(wkt.data))
    if (crs) return { ...crs, source: 'wkt' }
  }
  const keys = vlrs.find((v) => v.userId === 'LASF_Projection' && v.recordId === 34735)
  const crs = keys ? crsFromGeoKeys(keys.data) : null
  return crs ? { ...crs, source: 'geokeys' } : null
}

// LAS 1.4 extended VLRs (a WKT may be there instead of in the VLRs). → [{ userId, recordId, data }]
async function readEvlrs(source, bytes) {
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  if (bytes.byteLength < 247) return []
  let at = Number(dv.getBigUint64(235, true))
  const n = dv.getUint32(243, true)
  const out = []
  for (let k = 0; k < n && at > 0 && at + 60 <= source.size; k++) {
    const head = await source.read(at, at + 60)
    const hv = new DataView(head.buffer, head.byteOffset, head.byteLength)
    const userId = String.fromCharCode(...head.subarray(2, 18)).replace(/\0+$/, '')
    const recordId = hv.getUint16(18, true),
      length = Number(hv.getBigUint64(20, true))
    // Only the projection records are read (the hierarchy is read through the info VLR).
    if (userId === 'LASF_Projection' && length < 1 << 20)
      out.push({ userId, recordId, data: await source.read(at + 60, at + 60 + length) })
    at += 60 + length
  }
  return out
}

// ── The file ─────────────────────────────────────────────────────────────────

/**
 * Header, COPC info, LASzip VLR and projection records of a COPC file.
 * → { header, info, lazVlr: Uint8Array, projection: [{ userId, recordId, data }], crs }
 */
export async function readCopcFile(source) {
  const first = await source.read(0, Math.min(source.size, 375))
  const offsetToPoints =
    first.length >= 100 ? new DataView(first.buffer, first.byteOffset, first.byteLength).getUint32(96, true) : 0
  const bytes = await source.read(0, Math.min(source.size, Math.max(offsetToPoints, 375)))
  const header = readLasHeader(bytes)
  const info = readCopcInfo(header)
  if (!info) throw new Error('Not a COPC file (no "copc" info VLR first)')
  if (!COPC_FORMATS.has(header.format)) throw new Error(`COPC: point format ${header.format} (COPC uses 6, 7 or 8)`)
  if (
    !(info.halfsize > 0) ||
    !(info.rootPage.length >= ENTRY) ||
    info.rootPage.offset + info.rootPage.length > source.size
  ) {
    throw new Error('COPC: invalid info VLR (root cube or hierarchy page outside the file)')
  }
  const laz = header.vlrs.find((v) => v.userId === LASZIP_VLR_USER_ID && v.recordId === LASZIP_VLR_RECORD_ID)
  if (!laz) throw new Error('COPC: no "laszip encoded" VLR (record 22204)')
  const projection = [...header.vlrs.filter((v) => v.userId === 'LASF_Projection'), ...(await readEvlrs(source, bytes))]
  return { header, info, lazVlr: laz.data.slice(), projection, crs: crsFromVlrs(projection) }
}

/**
 * The quantisation the cloud is drawn and written in: the file's scale, and its
 * offset moved by whole steps to the root cube's centre, so render positions
 * (relative to it, Float32) stay precise even when a writer put the offset at 0.
 */
function copcLayout(header, info, colour) {
  const offset = [0, 1, 2].map(
    (k) => header.offset[k] + Math.round((info.center[k] - header.offset[k]) / header.scale[k]) * header.scale[k],
  )
  return { offset, scale: [...header.scale], colour, attributes: STREAM_ATTRIBUTES.map((a) => ({ ...a })) }
}

/**
 * Points of one node's decoded records. `as`: 'render' → Float32 positions relative
 * to the layout's offset; 'absolute' → Float64 in the file's coordinates.
 * → { count, pos, col: Uint8Array | null, attributes }
 */
export function decodeCopcRecords(records, count, lod, { as = 'render' } = {}) {
  const c = lod.copc
  const dec = createLasDecoder(count, c.recordLength, c.pointFormat, lod.layout.scale, c.fileOffset, [], {
    rgbBits: c.rgbBits,
  })
  if (count) dec.decode(records, 0, count)
  const out = dec.finish()
  let pos = out.pos
  if (as !== 'absolute') {
    const [ox, oy, oz] = lod.layout.offset
    pos = new Float32Array(3 * count)
    for (let i = 0; i < count; i++) {
      pos[3 * i] = out.pos[3 * i] - ox
      pos[3 * i + 1] = out.pos[3 * i + 1] - oy
      pos[3 * i + 2] = out.pos[3 * i + 2] - oz
    }
  }
  return {
    count,
    pos,
    col: lod.layout.colour ? (out.col ?? new Uint8Array(3 * count)) : null,
    attributes: streamAttributes(out.attributes, count),
  }
}

/**
 * A COPC file as a cloud source: the reader interface of core/lod/reader.js
 * ({ nodes, root, children, cube, spacing, read(node, { as }) }) plus `loadAll()`
 * (every hierarchy page), `complete` and `close()`.
 * opts: createChunkDecoder (the codec, see top) or readNode(node, as) → points (a
 * node read elsewhere, e.g. in a worker); hierarchy 'all' | 'lazy': the pages below the
 * root page are read as `read` reaches the nodes above them.
 */
export async function openCopcSource(
  lod,
  source,
  { createChunkDecoder = null, readNode = null, hierarchy = 'all' } = {},
) {
  const nodes = new Map()
  const pages = new Map() // keyString → { offset, length }: a page not read yet
  const reading = new Map() // keyString → Promise
  async function readPage({ offset, length }) {
    if (offset + length > source.size || length < ENTRY) throw new Error('COPC: hierarchy page outside the file')
    for (const e of parseHierarchyPage(await source.read(offset, offset + length))) {
      const s = keyString(e.key)
      if (e.count === -1) {
        if (!nodes.has(s)) pages.set(s, { offset: e.offset, length: e.length })
      } else {
        nodes.set(s, { key: e.key, count: e.count, offset: e.offset, length: e.length })
        pages.delete(s)
      }
    }
  }
  function readPending(s) {
    if (!reading.has(s))
      reading.set(
        s,
        readPage(pages.get(s)).finally(() => {
          pages.delete(s)
          reading.delete(s)
        }),
      )
    return reading.get(s)
  }
  async function loadAll() {
    while (pages.size) await Promise.all([...pages.keys()].map(readPending))
  }
  // The pages holding a node's children, so the view can walk on below it.
  function childPages(node) {
    const out = []
    for (let o = 0; o < 8; o++) {
      const s = keyString(childKey(node.key, o))
      if (pages.has(s)) out.push(readPending(s))
    }
    return Promise.all(out)
  }
  await readPage(lod.copc.rootPage)
  if (hierarchy === 'all') await loadAll()

  let decoder = null
  const lazVlr = lod.copc.lazVlr instanceof Uint8Array ? lod.copc.lazVlr : fromBase64(lod.copc.lazVlr)
  async function points(node, as) {
    if (!node.count) return decodeCopcRecords(new Uint8Array(0), 0, lod, { as })
    if (readNode) return readNode(node, as)
    if (!createChunkDecoder) throw new Error('COPC: reading points needs the lazcodec WASM module')
    decoder ??= createChunkDecoder(lazVlr)
    const bytes = await source.read(node.offset, node.offset + node.length)
    return decodeCopcRecords(decoder.decode(bytes, node.count), node.count, lod, { as })
  }

  return {
    nodes,
    get root() {
      return nodes.get('0-0-0-0') ?? null
    },
    get complete() {
      return pages.size === 0
    },
    loadAll,
    children(node) {
      const out = []
      for (let o = 0; o < 8; o++) {
        const c = nodes.get(keyString(childKey(node.key, o)))
        if (c) out.push(c)
      }
      return out
    },
    cube: (node) => nodeCube(lod.root, node.key),
    spacing: (node) => lod.spacing / 2 ** node.key[0],
    // Ours keeps about GRID² points on a surface in every node, and the view refines a
    // node's children once they are big enough on screen for that. A COPC writer's top
    // levels can be far sparser (PDAL: 809 points in the root of a 93 M-point survey),
    // so their children are refined sooner, in proportion to the points across the node.
    refineScale: (node) => Math.min(1, Math.max(0.1, Math.sqrt(node.count) / GRID)),
    async read(node, { as = 'render' } = {}) {
      const [pts] = await Promise.all([points(node, as), childPages(node)])
      return pts
    },
    close() {
      decoder?.free?.()
      decoder = null
    },
  }
}

/**
 * The cloud's `lod` metadata from a COPC file, read in place: the hierarchy (all of
 * it: a few dozen bytes per node), the colour depth from the root node, and the
 * styling statistics from the top levels (the levels are even subsamples, so their
 * class shares and value ranges are the cloud's; class counts are scaled to the
 * total and marked `sampled`).
 */
export async function readCopcMeta(source, { createChunkDecoder, statsPoints = COPC_STATS_POINTS, onLog } = {}) {
  const { header: h, info, lazVlr, projection, crs } = await readCopcFile(source)
  const rgbOff = RGB_OFFSET[h.format]
  const lod = {
    format: 'copc',
    root: { min: info.center.map((c) => c - info.halfsize), size: 2 * info.halfsize },
    spacing: info.spacing,
    layout: copcLayout(h, info, rgbOff != null),
    bounds: { min: [...h.bounds.min], max: [...h.bounds.max] },
    points: h.count,
    copc: {
      pointFormat: h.format,
      recordLength: h.recordLength,
      fileOffset: [...h.offset],
      lazVlr: toBase64(lazVlr),
      rootPage: info.rootPage,
      rgbBits: null,
    },
  }
  const src = await openCopcSource(lod, source, { createChunkDecoder })
  try {
    let nodeCount = 0,
      levels = 0,
      total = 0
    const perLevel = []
    for (const n of src.nodes.values()) {
      nodeCount++
      total += n.count
      levels = Math.max(levels, n.key[0] + 1)
      ;(perLevel[n.key[0]] ??= []).push(n)
    }
    if (total !== h.count)
      onLog?.(
        `COPC: the hierarchy holds ${total.toLocaleString()} points, the header says ${h.count.toLocaleString()} — using the hierarchy`,
        'warn',
        'Import',
      )
    lod.points = total

    // Colour depth from the root's raw records (the spec says 16-bit, many writers store 0–255).
    if (rgbOff != null && src.root?.count) {
      const recs = createChunkDecoder(lazVlr)
      try {
        const records = recs.decode(
          await source.read(src.root.offset, src.root.offset + src.root.length),
          src.root.count,
        )
        const dv = new DataView(records.buffer, records.byteOffset, records.byteLength)
        let max = 0
        for (let i = 0, p = rgbOff; i < src.root.count && max <= 255; i++, p += h.recordLength) {
          max = Math.max(max, dv.getUint16(p, true), dv.getUint16(p + 2, true), dv.getUint16(p + 4, true))
        }
        lod.copc.rgbBits = max > 255 ? 16 : 8
        if (max === 0) {
          lod.layout.colour = false
          onLog?.('COPC: the colour fields are empty — read without colour', 'info', 'Import')
        }
      } finally {
        recs.free?.()
      }
    }

    // Statistics from the top levels, whole levels until statsPoints.
    const ranges = Object.fromEntries(lod.layout.attributes.map((a) => [a.name, { min: Infinity, max: -Infinity }]))
    const classes = {}
    let sampled = 0
    for (const level of perLevel) {
      if (!level) continue
      const n = level.reduce((s, x) => s + x.count, 0)
      if (sampled && sampled + n > statsPoints) break
      for (const node of level) {
        if (!node.count) continue
        const pts = await src.read(node, { as: 'absolute' })
        for (const [name, r] of Object.entries(ranges)) {
          const arr = pts.attributes[name]
          for (let i = 0; i < pts.count; i++) {
            const v = arr[i]
            if (v < r.min) r.min = v
            if (v > r.max) r.max = v
          }
          if (name === 'classification')
            for (let i = 0; i < pts.count; i++) classes[arr[i]] = (classes[arr[i]] ?? 0) + 1
        }
      }
      sampled += n
    }
    for (const r of Object.values(ranges))
      if (r.min > r.max) {
        r.min = 0
        r.max = 1
      }
    if (sampled < total) for (const k of Object.keys(classes)) classes[k] = Math.round((classes[k] * total) / sampled)
    lod.stats = { ranges, classes, ...(sampled < total ? { sampled } : {}) }
    Object.assign(lod, {
      nodeCount,
      levels,
      dataBytes: source.size,
      hierarchyBytes: ENTRY * nodeCount,
      file: {
        version: `${h.versionMajor}.${h.versionMinor}`,
        format: h.format,
        laz: true,
        copc: true,
        // The projection records go back into a LAS written from the cloud.
        projection: projection.map((v) => ({
          userId: v.userId,
          recordId: v.recordId,
          description: '',
          data: toBase64(v.data),
        })),
        crs: crs?.epsg ?? null,
        crsName: crs?.name ?? null,
      },
    })
  } finally {
    src.close()
  }
  return lod
}
