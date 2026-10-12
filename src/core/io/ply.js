// PLY point-cloud / mesh reader. Pure bytes → flat arrays; no per-point objects
// (dense-scale invariant). Handles ascii and binary_little_endian 1.0 (big-endian
// is rejected with a clear error); reads x/y/z (float or double), colors
// (red/green/blue or diffuse_red/…, uchar), normals (nx/ny/nz, float/double),
// and — when an `element face` exists — triangle indices from a
// `property list <uchar|uint8|…> <int|uint|…> vertex_indices|vertex_index`.
// Other scalar vertex properties are retained as named point attributes.
// Polygons with >3 vertices are fanned into triangles.
//
// Returns a cloud { count, pos: Float64Array(3N), col?: Uint8Array(3N),
// nrm?: Float32Array(3N) } or, with faces, a mesh { nVerts, count /* tris */,
// pos, idx: Uint32Array(3T), col? }.

const SCALAR_BYTES = {
  char: 1, uchar: 1, int8: 1, uint8: 1,
  short: 2, ushort: 2, int16: 2, uint16: 2,
  int: 4, uint: 4, int32: 4, uint32: 4, float: 4, float32: 4,
  double: 8, float64: 8,
}

function readScalar(dv, offset, type) {
  switch (type) {
    case 'char': case 'int8': return dv.getInt8(offset)
    case 'uchar': case 'uint8': return dv.getUint8(offset)
    case 'short': case 'int16': return dv.getInt16(offset, true)
    case 'ushort': case 'uint16': return dv.getUint16(offset, true)
    case 'int': case 'int32': return dv.getInt32(offset, true)
    case 'uint': case 'uint32': return dv.getUint32(offset, true)
    case 'float': case 'float32': return dv.getFloat32(offset, true)
    case 'double': case 'float64': return dv.getFloat64(offset, true)
    default: throw new Error(`PLY: unknown scalar type "${type}"`)
  }
}

// Parse the header text into { format, elements: [{ name, count, props }] } where
// props is [{ name, type, listCountType?, listItemType? }].
function parseHeader(text) {
  const lines = text.split(/\r?\n/)
  let format = null
  const elements = []
  let cur = null
  for (const line of lines) {
    const tok = line.trim().split(/\s+/)
    if (tok[0] === 'format') format = tok[1]
    else if (tok[0] === 'element') {
      cur = { name: tok[1], count: Number(tok[2]), props: [] }
      elements.push(cur)
    } else if (tok[0] === 'property' && cur) {
      if (tok[1] === 'list') cur.props.push({ name: tok[4], type: 'list', listCountType: tok[2], listItemType: tok[3] })
      else cur.props.push({ name: tok[2], type: tok[1] })
    }
  }
  return { format, elements }
}

const COLOR_NAMES = { red: 0, green: 1, blue: 2, diffuse_red: 0, diffuse_green: 1, diffuse_blue: 2 }
const FACE_LIST_NAMES = new Set(['vertex_indices', 'vertex_index'])

// Header end + layout from the leading bytes (the header is ASCII and must fit
// the first 64 KiB, as it always has).
function readPlyHeader(bytes) {
  const probe = new TextDecoder().decode(bytes.subarray(0, Math.min(bytes.length, 65536)))
  if (!/^ply\r?\n/.test(probe)) throw new Error('Not a PLY file (missing "ply" magic)')
  const endMatch = /end_header\r?\n/.exec(probe)
  if (!endMatch) throw new Error('PLY: header end not found (truncated file?)')
  const bodyOffset = endMatch.index + endMatch[0].length
  const { format, elements } = parseHeader(probe.slice(0, endMatch.index))

  if (format === 'binary_big_endian') {
    throw new Error('PLY: big-endian binary files are not supported — re-export as little-endian or ascii')
  }
  if (format !== 'ascii' && format !== 'binary_little_endian') {
    throw new Error(`PLY: unsupported format "${format}"`)
  }
  return { format, elements, bodyOffset }
}

// Vertex layout + output arrays for one parse. Triangles grow in a typed array
// (a JS number array of 30 M indices is the heap trap this format invites).
function plyState({ format, elements }) {
  const vertexEl = elements.find((e) => e.name === 'vertex')
  if (!vertexEl) throw new Error('PLY: no vertex element')
  const faceEl = elements.find((e) => e.name === 'face')

  // Column/byte layout of the vertex element.
  const layout = { x: null, y: null, z: null, col: [null, null, null], nrm: [null, null, null] }
  const scalarFields = []
  let stride = 0
  vertexEl.props.forEach((p, i) => {
    if (p.type === 'list') throw new Error(`PLY: list property "${p.name}" on the vertex element is not supported`)
    const slot = { index: i, offset: stride, type: p.type }
    if (p.name === 'x') layout.x = slot
    else if (p.name === 'y') layout.y = slot
    else if (p.name === 'z') layout.z = slot
    else if (p.name in COLOR_NAMES) layout.col[COLOR_NAMES[p.name]] = slot
    else if (p.name === 'nx') layout.nrm[0] = slot
    else if (p.name === 'ny') layout.nrm[1] = slot
    else if (p.name === 'nz') layout.nrm[2] = slot
    else scalarFields.push({ name: p.name, ...slot })
    stride += SCALAR_BYTES[p.type] ?? (() => { throw new Error(`PLY: unknown property type "${p.type}"`) })()
  })
  if (!layout.x || !layout.y || !layout.z) throw new Error('PLY: vertex element lacks x/y/z')
  const hasCol = layout.col.every((s) => s !== null)
  const hasNrm = layout.nrm.every((s) => s !== null)

  const n = vertexEl.count
  return {
    format, elements, faceEl, layout, scalarFields, stride, n,
    pos: new Float64Array(n * 3),
    col: hasCol ? new Uint8Array(n * 3) : null,
    nrm: hasNrm ? new Float32Array(n * 3) : null,
    attributes: Object.fromEntries(scalarFields.map(field => [field.name, new Float64Array(n)])),
    tris: growableU32(), // flat triangle indices (fanned)
  }
}

function growableU32() {
  let buf = new Uint32Array(1024), len = 0
  return {
    push(v) {
      if (len === buf.length) { const next = new Uint32Array(buf.length * 2); next.set(buf); buf = next }
      buf[len++] = v
    },
    get length() { return len },
    take() { return buf.slice(0, len) },
  }
}

// Color scale: uchar is the norm; float 0–1 colors appear in the wild.
const colByte = (v, type) =>
  Math.max(0, Math.min(255, Math.round(type === 'float' || type === 'double' || type === 'float32' || type === 'float64' ? v * 255 : v)))

const isFaceList = (el) => el.name === 'face' && el.props.some((p) => p.type === 'list' && FACE_LIST_NAMES.has(p.name))

// The ASCII body, one line at a time, walking element by element: push(text) any
// number of times (partial lines are carried), then finish().
function plyAsciiBody(st) {
  const { elements, layout, scalarFields, pos, col, nrm, attributes, tris } = st
  let ei = 0, ri = 0, carry = ''
  const advance = () => { while (ei < elements.length && ri >= elements[ei].count) { ei++; ri = 0 } }
  advance()
  function line(l) {
    if (!l.trim() || l.startsWith('comment')) return
    if (ei >= elements.length) return
    const el = elements[ei]
    if (el.name === 'vertex') {
      const i = ri
      const t = l.trim().split(/\s+/)
      pos[i * 3] = Number(t[layout.x.index])
      pos[i * 3 + 1] = Number(t[layout.y.index])
      pos[i * 3 + 2] = Number(t[layout.z.index])
      for (const field of scalarFields) attributes[field.name][i] = Number(t[field.index])
      if (col) for (let c = 0; c < 3; c++) col[i * 3 + c] = colByte(Number(t[layout.col[c].index]), layout.col[c].type)
      if (nrm) for (let c = 0; c < 3; c++) nrm[i * 3 + c] = Number(t[layout.nrm[c].index])
    } else if (isFaceList(el)) {
      const t = l.trim().split(/\s+/).map(Number)
      const k = t[0]
      for (let v = 2; v < k; v++) { tris.push(t[1]); tris.push(t[v]); tris.push(t[v + 1]) }
    } // else: an element we do not read, skipped line by line
    ri++
    advance()
  }
  const strip = (l) => (l.endsWith('\r') ? l.slice(0, -1) : l)
  return {
    push(text) {
      const lines = (carry + text).split('\n')
      carry = lines.pop()
      for (const l of lines) line(strip(l))
    },
    finish() {
      line(strip(carry)); carry = ''
      // Running out inside a vertex or face element is a truncated file; trailing
      // elements we only skip are not read anyway.
      for (let k = ei; k < elements.length; k++) {
        const el = elements[k]
        if ((el.name === 'vertex' || isFaceList(el)) && el.count > (k === ei ? ri : 0)) {
          throw new Error('PLY: ascii data truncated')
        }
      }
    },
  }
}

function plyBinaryBody(st, bytes, bodyOffset) {
  const { elements, layout, scalarFields, stride, n, pos, col, nrm, attributes, tris } = st
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  let p = bodyOffset
  for (const el of elements) {
    if (el.name === 'vertex') {
      if (p + n * stride > bytes.length) throw new Error('PLY: vertex data truncated')
      for (let i = 0; i < n; i++) {
        pos[i * 3] = readScalar(dv, p + layout.x.offset, layout.x.type)
        pos[i * 3 + 1] = readScalar(dv, p + layout.y.offset, layout.y.type)
        pos[i * 3 + 2] = readScalar(dv, p + layout.z.offset, layout.z.type)
        if (col) for (let c = 0; c < 3; c++) col[i * 3 + c] = colByte(readScalar(dv, p + layout.col[c].offset, layout.col[c].type), layout.col[c].type)
        if (nrm) for (let c = 0; c < 3; c++) nrm[i * 3 + c] = readScalar(dv, p + layout.nrm[c].offset, layout.nrm[c].type)
        for (const field of scalarFields) attributes[field.name][i] = readScalar(dv, p + field.offset, field.type)
        p += stride
      }
    } else {
      // Walk any list-bearing element record by record (fixed stride otherwise).
      const listProp = el.props.find((pr) => pr.type === 'list')
      const isFace = el.name === 'face' && listProp && FACE_LIST_NAMES.has(listProp.name)
      if (!listProp) { p += el.count * el.props.reduce((s, pr) => s + SCALAR_BYTES[pr.type], 0); continue }
      for (let f = 0; f < el.count; f++) {
        for (const pr of el.props) {
          if (pr.type !== 'list') { p += SCALAR_BYTES[pr.type]; continue }
          const k = readScalar(dv, p, pr.listCountType)
          p += SCALAR_BYTES[pr.listCountType]
          if (isFace && pr === listProp) {
            const idx = new Array(k)
            for (let v = 0; v < k; v++) { idx[v] = readScalar(dv, p, pr.listItemType); p += SCALAR_BYTES[pr.listItemType] }
            for (let v = 1; v + 1 < k; v++) { tris.push(idx[0]); tris.push(idx[v]); tris.push(idx[v + 1]) }
          } else {
            p += k * SCALAR_BYTES[pr.listItemType]
          }
        }
      }
    }
  }
}

function plyResult(st, { onLog }) {
  const { format, faceEl, n, pos, col, nrm, attributes, tris } = st
  if (faceEl && tris.length) {
    onLog?.(`PLY: read mesh — ${n.toLocaleString()} vertices, ${(tris.length / 3).toLocaleString()} triangles`
      + `${col ? ', color' : ''}`, 'info', 'Import')
    return { attributes, nVerts: n, count: tris.length / 3, pos, idx: tris.take(), ...(col ? { col } : {}) }
  }
  onLog?.(`PLY: read ${n.toLocaleString()} points (${format}${col ? ', color' : ''}${nrm ? ', normals' : ''})`, 'info', 'Import')
  return { attributes, count: n, pos, ...(col ? { col } : {}), ...(nrm ? { nrm } : {}) }
}

export function parsePly(buffer, { onLog } = {}) {
  const bytes = typeof buffer === 'string' ? new TextEncoder().encode(buffer)
    : buffer instanceof Uint8Array ? buffer
      : new Uint8Array(buffer)
  const header = readPlyHeader(bytes)
  const st = plyState(header)
  if (header.format === 'ascii') {
    // The body is text: walk it line by line, element by element.
    const body = plyAsciiBody(st)
    body.push(new TextDecoder().decode(bytes.subarray(header.bodyOffset)))
    body.finish()
  } else plyBinaryBody(st, bytes, header.bodyOffset)
  return plyResult(st, { onLog })
}

// The same reader over injected I/O ({ size, read(start, end), chunks(start) } —
// utils/blobParts.js blobSource): an ASCII body is decoded and parsed chunk by
// chunk and never becomes one string; a binary body is read whole (fixed-stride
// records in an ArrayBuffer, outside the JS heap).
export async function parsePlySource(source, { onLog } = {}) {
  const head = await source.read(0, Math.min(source.size, 65536))
  const header = readPlyHeader(head)
  if (header.format !== 'ascii') return parsePly(await source.read(0, source.size), { onLog })
  const st = plyState(header)
  const body = plyAsciiBody(st)
  const dec = new TextDecoder()
  for await (const chunk of source.chunks(header.bodyOffset)) body.push(dec.decode(chunk, { stream: true }))
  body.push(dec.decode())
  body.finish()
  return plyResult(st, { onLog })
}
