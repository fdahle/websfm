import { describe, it, expect } from 'vitest'
import { cloudToPlyParts, meshToPlyParts, meshToGlbParts, meshToObjParts, meshToStlParts, reconstructionToJson, demToAsciiGridParts, rasterWorldFile, prepareCloudForExport, prepareMeshForExport, objMaterialLibrary } from './exporters.js'
import { joinParts, jsonParts } from '../io/parts.js'

// The writers yield bounded parts (core/io/parts.js); these join them for small fixtures.
const cloudToPly = (...a) => joinParts(cloudToPlyParts(...a))
const meshToPly = (...a) => joinParts(meshToPlyParts(...a))
const meshToGlb = (...a) => joinParts(meshToGlbParts(...a))
const meshToObj = (...a) => joinParts(meshToObjParts(...a))
const meshToStl = (...a) => joinParts(meshToStlParts(...a))
const demToAsciiGrid = (...a) => joinParts(demToAsciiGridParts(...a))

describe('meshToPly', () => {
  // A single triangle with per-vertex colour.
  const mesh = {
    nVerts: 3, count: 1,
    pos: Float32Array.from([0, 0, 0, 1, 0, 0, 0, 1, 0]),
    idx: Uint32Array.from([0, 1, 2]),
    col: Uint8Array.from([255, 0, 0, 0, 255, 0, 0, 0, 255]),
  }

  it('writes an ASCII PLY with vertex + face elements', () => {
    const ascii = meshToPly(mesh, { binary: false })
    expect(ascii).toContain('element vertex 3')
    expect(ascii).toContain('element face 1')
    expect(ascii).toContain('property list uchar int vertex_indices')
    expect(ascii).toContain('3 0 1 2') // the triangle face row
  })

  it('writes a binary PLY of the right total size', () => {
    const bytes = meshToPly(mesh)
    const header = new TextDecoder().decode(bytes.subarray(0, 512))
    const headerLen = header.indexOf('end_header\n') + 'end_header\n'.length
    // 3 verts × (12 pos + 3 col) + 1 face × (1 + 12).
    expect(bytes.length).toBe(headerLen + 3 * 15 + 1 * 13)
  })
})

describe('meshToGlb', () => {
  const mesh = {
    nVerts: 3, count: 1,
    pos: Float32Array.from([0, 0, 0, 2, 0, 0, 0, 4, 0]),
    idx: Uint32Array.from([0, 1, 2]),
    col: Uint8Array.from([255, 0, 0, 0, 255, 0, 0, 0, 255]),
  }

  // Parse the GLB container: 12-byte header + JSON chunk + BIN chunk.
  function parseGlb(bytes) {
    const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
    expect(dv.getUint32(0, true)).toBe(0x46546c67) // 'glTF'
    expect(dv.getUint32(4, true)).toBe(2)
    const total = dv.getUint32(8, true)
    expect(total).toBe(bytes.length)
    const jsonLen = dv.getUint32(12, true)
    expect(dv.getUint32(16, true)).toBe(0x4e4f534a) // 'JSON'
    const json = JSON.parse(new TextDecoder().decode(bytes.subarray(20, 20 + jsonLen)))
    const binOff = 20 + jsonLen
    expect(dv.getUint32(binOff + 4, true)).toBe(0x004e4942) // 'BIN\0'
    return json
  }

  it('emits a valid single-mesh glTF with POSITION, COLOR_0 and indices', () => {
    const glb = meshToGlb(mesh)
    // 4-byte aligned total length.
    expect(glb.length % 4).toBe(0)
    const json = parseGlb(glb)
    expect(json.asset.version).toBe('2.0')
    expect(json.meshes).toHaveLength(1)
    const prim = json.meshes[0].primitives[0]
    expect(prim.attributes.POSITION).toBe(0)
    expect(prim.attributes.COLOR_0).toBe(1)
    expect(typeof prim.indices).toBe('number')
    // POSITION accessor: 3 verts, VEC3, with min/max spanning the triangle.
    const posAcc = json.accessors[prim.attributes.POSITION]
    expect(posAcc.count).toBe(3)
    expect(posAcc.type).toBe('VEC3')
    expect(posAcc.max).toEqual([2, 4, 0])
    expect(posAcc.min).toEqual([0, 0, 0])
    // Indices accessor: 3 scalars, u32.
    const idxAcc = json.accessors[prim.indices]
    expect(idxAcc.count).toBe(3)
    expect(idxAcc.type).toBe('SCALAR')
    expect(idxAcc.componentType).toBe(5125)
  })

  it('omits COLOR_0 when the mesh has no colour', () => {
    const glb = meshToGlb({ ...mesh, col: null })
    const json = parseGlb(glb)
    expect(json.meshes[0].primitives[0].attributes.COLOR_0).toBeUndefined()
  })
})

describe('cloudToPly', () => {
  const points = [
    { x: 1.5, y: -2.25, z: 3.0, color: [255, 0, 128] },
    { x: 0, y: 0, z: 0 }, // no colour → default grey
  ]

  it('writes a valid binary PLY header with the right vertex count', () => {
    const bytes = cloudToPly(points)
    const text = new TextDecoder().decode(bytes.subarray(0, 256))
    expect(text.startsWith('ply\n')).toBe(true)
    expect(text).toContain('format binary_little_endian 1.0')
    expect(text).toContain('element vertex 2')
    expect(text).toContain('end_header\n')
  })

  it('packs xyz as little-endian float32 + rgb as uint8', () => {
    const bytes = cloudToPly(points)
    const headerLen = bytes.length - points.length * 15
    const dv = new DataView(bytes.buffer, headerLen)
    expect(dv.getFloat32(0, true)).toBeCloseTo(1.5, 5)
    expect(dv.getFloat32(4, true)).toBeCloseTo(-2.25, 5)
    expect(dv.getFloat32(8, true)).toBeCloseTo(3.0, 5)
    expect(dv.getUint8(12)).toBe(255)
    expect(dv.getUint8(13)).toBe(0)
    expect(dv.getUint8(14)).toBe(128)
    // Second vertex: default grey.
    expect(dv.getUint8(15 + 12)).toBe(200)
  })

  it('writes ASCII PLY, and honours color:false (no rgb properties)', () => {
    const ascii = cloudToPly(points, { binary: false })
    expect(typeof ascii).toBe('string')
    expect(ascii).toContain('format ascii 1.0')
    expect(ascii).toContain('1.5 -2.25 3 255 0 128')

    const noColor = cloudToPly(points, { binary: false, color: false })
    expect(noColor).not.toContain('property uchar red')
    expect(noColor).toContain('1.5 -2.25 3\n')
  })

  it('accepts the flat dense shape { count, pos, col } identically to the object array', () => {
    const flat = {
      count: 2,
      pos: Float32Array.from([1.5, -2.25, 3.0, 0, 0, 0]),
      col: Uint8Array.from([255, 0, 128, 10, 20, 30]),
    }
    const ascii = cloudToPly(flat, { binary: false })
    expect(ascii).toContain('element vertex 2')
    expect(ascii).toContain('1.5 -2.25 3 255 0 128')
    expect(ascii).toContain('0 0 0 10 20 30')

    const bytes = cloudToPly(flat)
    const headerLen = bytes.length - 2 * 15
    const dv = new DataView(bytes.buffer, headerLen)
    expect(dv.getFloat32(0, true)).toBeCloseTo(1.5, 5)
    expect(dv.getUint8(12)).toBe(255)
    expect(dv.getUint8(15 + 12)).toBe(10) // second point's red from col buffer
  })
})

describe('reconstructionToJson', () => {
  it('emits cameras with centres (C = −Rᵀt) + tracks + crs', () => {
    const cameras = [{ uuid: 'a', R: [[1, 0, 0], [0, 1, 0], [0, 0, 1]], t: [1, 2, 3], K: { fx: 100, fy: 100, cx: 50, cy: 40, extra: 9 } }]
    const points = [{ x: 1, y: 2, z: 3, color: [10, 20, 30], views: [['a', 5]] }]
    // points is a lazyArray: read the document the way the export writes it.
    const j = JSON.parse(joinParts(jsonParts(reconstructionToJson(cameras, points, 'EPSG:3031'))))
    expect(j.crs).toBe('EPSG:3031')
    expect(j.cameras[0].center).toEqual([-1, -2, -3]) // identity R ⇒ C = −t
    expect(j.cameras[0].K).toEqual({ fx: 100, fy: 100, cx: 50, cy: 40 }) // trimmed
    expect(j.points[0].views).toEqual([['a', 5]])
  })
})

describe('demToAsciiGrid', () => {
  const dem = {
    width: 2, height: 2, gsd: 10, originX: 100, originY: 200,
    data: Float32Array.from([1, 2, NaN, 4]), // row-major, top→bottom; NaN = hole
  }

  it('writes the ESRI header with a lower-left corner derived from the top origin', () => {
    const asc = demToAsciiGrid(dem)
    expect(asc).toContain('ncols 2\n')
    expect(asc).toContain('nrows 2\n')
    expect(asc).toContain('xllcorner 100\n')
    expect(asc).toContain('yllcorner 180\n') // originY − height·gsd = 200 − 20
    expect(asc).toContain('cellsize 10\n')
    expect(asc).toContain('NODATA_value -9999\n')
  })

  it('emits rows top→bottom and maps NaN to NODATA', () => {
    const body = demToAsciiGrid(dem).trim().split('\n').slice(6)
    expect(body).toEqual(['1 2', '-9999 4'])
  })
})

describe('rasterWorldFile', () => {
  it('emits 6 lines with pixel size + upper-left pixel centre', () => {
    const wld = rasterWorldFile({ gsd: 10, originX: 100, originY: 200 }).trim().split('\n').map(Number)
    expect(wld).toEqual([10, 0, 0, -10, 105, 195]) // centre = corner ± gsd/2
  })
})

describe('prepareCloudForExport', () => {
  const IDENTITY = [[1, 0, 0], [0, 1, 0], [0, 0, 1]]

  it('returns the input untouched when neither option is active', () => {
    const pts = [{ x: 1, y: 2, z: 3, color: [1, 2, 3] }]
    expect(prepareCloudForExport(pts, {})).toBe(pts)
  })

  it('applies the similarity transform (flat output, Float64 precision)', () => {
    const sim = { scale: 2, R: IDENTITY, t: [500000, 7100000, 100] }
    const out = prepareCloudForExport([{ x: 1, y: 2, z: 3, color: [9, 8, 7] }], { sim })
    expect(out.count).toBe(1)
    expect(out.pos).toBeInstanceOf(Float64Array)
    expect(out.pos[0]).toBeCloseTo(500002, 9)
    expect(out.pos[1]).toBeCloseTo(7100004, 9)
    expect(out.pos[2]).toBeCloseTo(106, 9)
    expect([...out.col]).toEqual([9, 8, 7])
  })

  it('downsamples with the cell in target-CRS units (georef applied first)', () => {
    // Two points 0.4 apart in the local frame → 0.8 apart after scale 2. A cell of
    // 1.0 in CRS units merges them ONLY if they land in the same CRS-frame cell;
    // with offset t=100.1 they straddle a cell boundary in the local frame but not
    // after the transform — proving georef runs first.
    const sim = { scale: 2, R: IDENTITY, t: [100.1, 0, 0] }
    const pts = [
      { x: 0.05, y: 0.25, z: 0.25, color: [10, 10, 10] },
      { x: 0.35, y: 0.25, z: 0.25, color: [30, 30, 30] },
    ]
    // CRS x: 100.2 and 100.8 → same cell [100,101) → merged to one averaged point.
    const out = prepareCloudForExport(pts, { sim, cell: 1.0 })
    expect(out.count).toBe(1)
    expect(out.pos[0]).toBeCloseTo(100.5, 6)
    expect(out.col[0]).toBe(20)
  })

  it('downsamples the flat dense shape and keeps survey-coordinate precision', () => {
    const n = 4
    const pos = new Float32Array(n * 3)
    for (let i = 0; i < n; i++) { pos[i * 3] = i * 0.01; pos[i * 3 + 1] = 0; pos[i * 3 + 2] = 0 }
    const sim = { scale: 1, R: IDENTITY, t: [500000, 7100000, 800] }
    const out = prepareCloudForExport({ count: n, pos, col: new Uint8Array(n * 3).fill(100) }, { sim, cell: 1.0 })
    expect(out.count).toBe(1)
    // All 4 average to x ≈ 500000.015 — a Float32 pipeline would lose this.
    expect(Math.abs(out.pos[0] - 500000.015)).toBeLessThan(1e-4)
    expect(out.col[0]).toBe(100)
  })

  it('carries attributes through a transform unchanged', () => {
    const sim = { scale: 2, R: IDENTITY, t: [100, 0, 0] }
    const distance = Float32Array.from([0.5, NaN])
    const out = prepareCloudForExport({ count: 2, pos: new Float64Array([0, 0, 0, 1, 1, 1]), attributes: { distance } }, { sim })
    expect(out.pos[3]).toBeCloseTo(102, 12)
    expect([...out.attributes.distance]).toEqual([0.5, NaN])
  })

  it('downsamples an attributed cloud to one real point per cell (no averaging)', () => {
    // Cell 1: three points in [0,1)³, one in [5,6)³. The first point of each cell is kept whole.
    const pos = new Float64Array([0.1, 0.1, 0.1, 0.9, 0.9, 0.9, 5.5, 5.5, 5.5, 0.5, 0.5, 0.5])
    const col = new Uint8Array([10, 10, 10, 20, 20, 20, 30, 30, 30, 40, 40, 40])
    const classification = Uint8Array.from([2, 6, 9, 6])
    const distance = Float32Array.from([1, 2, 3, 4])
    const logs = []
    const out = prepareCloudForExport({ count: 4, pos, col, attributes: { classification, distance } },
      { cell: 1, onLog: (m) => logs.push(m) })
    expect(out.count).toBe(2)
    expect([...out.pos]).toEqual([0.1, 0.1, 0.1, 5.5, 5.5, 5.5])
    expect([...out.col]).toEqual([10, 10, 10, 30, 30, 30])
    expect(out.attributes.classification).toBeInstanceOf(Uint8Array)
    expect([...out.attributes.classification]).toEqual([2, 9])
    expect([...out.attributes.distance]).toEqual([1, 3])
    expect(logs.at(-1)).toMatch(/one real point per cell/)
    // Never written into the source.
    expect([...distance]).toEqual([1, 2, 3, 4])
  })
})

describe('prepareMeshForExport', () => {
  it('transforms vertices without changing topology or colours', () => {
    const mesh = {
      nVerts: 2, count: 0,
      pos: Float32Array.from([1, 2, 3, 4, 5, 6]),
      idx: new Uint32Array(), col: Uint8Array.from([1, 2, 3, 4, 5, 6]),
    }
    const sim = { scale: 2, R: [[1, 0, 0], [0, 1, 0], [0, 0, 1]], t: [10, 20, 30] }
    const out = prepareMeshForExport(mesh, { sim })
    expect([...out.pos]).toEqual([12, 24, 36, 18, 30, 42])
    expect(out.idx).toBe(mesh.idx)
    expect(out.col).toBe(mesh.col)
  })

  it('returns the original mesh when no transform is requested', () => {
    const mesh = { nVerts: 0, pos: new Float32Array(), idx: new Uint32Array() }
    expect(prepareMeshForExport(mesh)).toBe(mesh)
  })
})

describe('meshToObj', () => {
  const mesh = {
    nVerts: 3, count: 1,
    pos: Float32Array.from([0, 0, 0, 1, 0, 0, 0, 1, 0]),
    idx: Uint32Array.from([0, 1, 2]),
    col: Uint8Array.from([255, 0, 0, 0, 255, 0, 0, 0, 255]),
  }

  it('writes 1-based face indices (the classic OBJ bug)', () => {
    const obj = meshToObj(mesh, { color: false })
    expect(obj).toContain('f 1 2 3') // 0,1,2 → 1,2,3
    expect(obj).not.toContain('f 0 1 2')
  })

  it('writes vertex colors as 0–1 on the v line', () => {
    const obj = meshToObj(mesh)
    expect(obj).toMatch(/v 0 0 0 1\.000000 0\.000000 0\.000000/)
  })

  it('omits colors when not requested', () => {
    const obj = meshToObj(mesh, { color: false })
    expect(obj).toContain('v 0 0 0\n')
  })
})

describe('meshToStl', () => {
  const mesh = {
    nVerts: 3, count: 1,
    pos: Float32Array.from([0, 0, 0, 1, 0, 0, 0, 1, 0]),
    idx: Uint32Array.from([0, 1, 2]),
  }

  it('writes the binary layout: 80 header + u32 count + 50/tri', () => {
    const stl = meshToStl(mesh)
    expect(stl.length).toBe(84 + 1 * 50)
    const dv = new DataView(stl.buffer)
    expect(dv.getUint32(80, true)).toBe(1)
    // Normal of the XY triangle is +Z.
    expect(dv.getFloat32(84, true)).toBeCloseTo(0, 6)
    expect(dv.getFloat32(88, true)).toBeCloseTo(0, 6)
    expect(dv.getFloat32(92, true)).toBeCloseTo(1, 6)
    // First vertex.
    expect(dv.getFloat32(96, true)).toBe(0)
  })

  it('writes a zero normal for a degenerate triangle (no NaN)', () => {
    const degen = {
      nVerts: 3, count: 1,
      pos: Float32Array.from([0, 0, 0, 0, 0, 0, 1, 1, 1]), // two coincident verts
      idx: Uint32Array.from([0, 1, 2]),
    }
    const dv = new DataView(meshToStl(degen).buffer)
    for (let i = 0; i < 3; i++) expect(dv.getFloat32(84 + i * 4, true)).toBe(0)
  })
})

describe('part writers — chunking never changes the bytes', () => {
  // Deterministic pseudo-random fixtures, big enough that tiny part sizes split them
  // many times.
  let seed = 7
  const rand = () => ((seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648)
  const n = 2000
  const cloud = {
    count: n,
    pos: Float32Array.from({ length: n * 3 }, () => (rand() - 0.5) * 1e4),
    col: Uint8Array.from({ length: n * 3 }, () => rand() * 256),
    nrm: Float32Array.from({ length: n * 3 }, () => rand() - 0.5),
    attributes: { distance: Float32Array.from({ length: n }, () => rand()), classification: Uint8Array.from({ length: n }, () => rand() * 20) },
  }
  const nV = 600, nF = 1100
  const mesh = {
    nVerts: nV, count: nF,
    pos: Float64Array.from({ length: nV * 3 }, () => rand() * 1e5),
    idx: Uint32Array.from({ length: nF * 3 }, () => Math.floor(rand() * nV)),
    col: Uint8Array.from({ length: nV * 3 }, () => rand() * 256),
  }
  const dem = { width: 16, height: 400, gsd: 0.5, originX: 1000, originY: 2000,
    data: Float32Array.from({ length: 16 * 400 }, () => (rand() < 0.1 ? NaN : rand() * 100)) }
  const tiny = { partBytes: 512, partChars: 512 }
  const writers = {
    'cloud PLY binary': (o) => cloudToPlyParts(cloud, { binary: true, ...o }),
    'cloud PLY ascii': (o) => cloudToPlyParts(cloud, { binary: false, ...o }),
    'mesh PLY binary': (o) => meshToPlyParts(mesh, { binary: true, ...o }),
    'mesh PLY ascii': (o) => meshToPlyParts(mesh, { binary: false, ...o }),
    'mesh OBJ': (o) => meshToObjParts(mesh, o),
    'mesh STL': (o) => meshToStlParts(mesh, o),
    'mesh GLB': (o) => meshToGlbParts(mesh, o),
    'DEM ASCII grid': (o) => demToAsciiGridParts(dem, o),
  }
  for (const [name, write] of Object.entries(writers)) {
    it(`${name}: many bounded parts, same bytes as one part`, () => {
      const parts = [...write(tiny)]
      expect(parts.length).toBeGreaterThan(10)
      // Binary parts are whole records within the limit; text parts close as soon as
      // they reach it, overshooting by at most one line.
      for (const p of parts) expect(p.length).toBeLessThan(512 + 400)
      expect(joinParts(parts)).toEqual(joinParts(write({})))
    })
  }

  it('an empty cloud keeps the historical lone newline after an ASCII header', () => {
    const text = cloudToPly([], { binary: false })
    expect(text.endsWith('end_header\n\n')).toBe(true)
    expect(demToAsciiGrid({ width: 0, height: 0, gsd: 1, originX: 0, originY: 0, data: new Float32Array(0) })
      .endsWith('NODATA_value -9999\n\n')).toBe(true)
  })

  it('GLB total length and BIN chunk length match the bytes written', () => {
    const glb = meshToGlb(mesh)
    const dv = new DataView(glb.buffer)
    expect(dv.getUint32(8, true)).toBe(glb.length)
    const jsonLen = dv.getUint32(12, true)
    expect(dv.getUint32(20 + jsonLen, true)).toBe(glb.length - 28 - jsonLen)
  })
})

// ── Textured meshes (core/products/texture/ output) ─────────────────────────────
describe('textured mesh export', () => {
  // A quad split over two atlas pages: triangle 0 on page 0, triangle 1 on page 1.
  const mesh = {
    nVerts: 6, count: 2,
    pos: Float64Array.from([10, 20, 1, 11, 20, 1, 11, 21, 1, 10, 20, 1, 11, 21, 1, 10, 21, 1]),
    idx: Uint32Array.of(0, 1, 2, 3, 4, 5),
    col: new Uint8Array(18).fill(200),
    uv: Float32Array.from([0.1, 0.9, 0.9, 0.9, 0.9, 0.1, 0.1, 0.9, 0.9, 0.1, 0.1, 0.1]),
  }
  const jpegA = Uint8Array.of(0xff, 0xd8, 1, 2, 3), jpegB = Uint8Array.of(0xff, 0xd8, 4, 5, 6, 7, 8)
  const texture = { pages: [{ bytes: jpegA, type: 'image/jpeg' }, { bytes: jpegB, type: 'image/jpeg' }],
    groups: [{ page: 0, start: 0, count: 1 }, { page: 1, start: 1, count: 1 }] }
  const parse = (bytes) => {
    const dv = new DataView(bytes.buffer, bytes.byteOffset)
    const jsonLen = dv.getUint32(12, true)
    const json = JSON.parse(new TextDecoder().decode(bytes.subarray(20, 20 + jsonLen)))
    const binOff = 20 + jsonLen + 8
    return { json, bin: bytes.subarray(binOff, binOff + dv.getUint32(20 + jsonLen, true)), total: dv.getUint32(8, true) }
  }

  it('GLB: UVs, one unlit primitive per page over its index range, pages embedded, no COLOR_0', () => {
    const bytes = meshToGlb(mesh, { texture })
    const { json, bin, total } = parse(bytes)
    expect(total).toBe(bytes.length)
    expect(json.extensionsUsed).toEqual(['KHR_materials_unlit'])
    const prims = json.meshes[0].primitives
    expect(prims.map((p) => p.material)).toEqual([0, 1])
    expect(prims[0].attributes.COLOR_0).toBeUndefined()
    const uvAcc = json.accessors[prims[0].attributes.TEXCOORD_0]
    expect(uvAcc).toMatchObject({ componentType: 5126, count: 6, type: 'VEC2' })
    const idx1 = json.accessors[prims[1].indices]
    expect(idx1).toMatchObject({ byteOffset: 12, count: 3, componentType: 5125 })
    expect(json.materials[1].extensions.KHR_materials_unlit).toEqual({})
    expect(json.materials[1].pbrMetallicRoughness.baseColorTexture.index).toBe(1)
    // Every bufferView offset is 4-byte aligned, and the images are the page bytes.
    for (const v of json.bufferViews) expect(v.byteOffset % 4).toBe(0)
    const img = (k) => { const v = json.bufferViews[json.images[k].bufferView]; return [...bin.subarray(v.byteOffset, v.byteOffset + v.byteLength)] }
    expect(img(0)).toEqual([...jpegA])
    expect(img(1)).toEqual([...jpegB])
    // UVs as written.
    const uvView = json.bufferViews[uvAcc.bufferView]
    const uvs = new Float32Array(bin.slice(uvView.byteOffset, uvView.byteOffset + uvView.byteLength).buffer)
    expect([...uvs].map((v) => +v.toFixed(3))).toEqual([...mesh.uv].map((v) => +v.toFixed(3)))
  })

  it('GLB: tile-local, Y-up positions for 3D Tiles', () => {
    const { json, bin } = parse(meshToGlb(mesh, { origin: [10, 20, 1], yUp: true }))
    const pos = new Float32Array(bin.slice(0, 18 * 4).buffer)
    // (x, y, z) − origin → (x, z, −y): vertex 2 is (1, 1, 0) → (1, 0, −1).
    expect([...pos.subarray(6, 9)]).toEqual([1, 0, -1])
    expect(json.accessors[0].min).toEqual([0, 0, -1])
    expect(json.accessors[0].max).toEqual([1, 0, 0])
  })

  it('GLB without a texture is unchanged by the new options', () => {
    expect(meshToGlb(mesh)).toEqual(meshToGlb(mesh, { texture: null }))
    expect(parse(meshToGlb(mesh)).json.meshes[0].primitives).toHaveLength(1)
  })

  it('OBJ: mtllib, flipped vt per vertex, usemtl per page, v/vt faces, no vertex colour', () => {
    const text = joinParts(meshToObjParts(mesh, { texture: { mtl: 'quad.mtl', groups: texture.groups } }))
    const lines = text.trim().split('\n')
    expect(lines[1]).toBe('mtllib quad.mtl')
    expect(lines.filter((l) => l.startsWith('v ')).every((l) => l.split(' ').length === 4)).toBe(true)
    const vt = lines.filter((l) => l.startsWith('vt '))
    expect(vt).toHaveLength(6)
    expect(vt[0]).toBe('vt 0.100000 0.100000') // v' = 1 − 0.9
    const tail = lines.slice(lines.findIndex((l) => l.startsWith('usemtl')))
    expect(tail).toEqual(['usemtl atlas-0', 'f 1/1 2/2 3/3', 'usemtl atlas-1', 'f 4/4 5/5 6/6'])
  })

  it('MTL: one unlit material per page, pointing at its image', () => {
    const mtl = objMaterialLibrary(['quad_atlas0.jpg', 'quad_atlas1.jpg'])
    expect(mtl).toContain('newmtl atlas-1\n')
    expect(mtl).toContain('map_Kd quad_atlas1.jpg\n')
    expect(mtl.match(/illum 0/g)).toHaveLength(2)
  })
})
