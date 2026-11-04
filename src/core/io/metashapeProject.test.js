import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { unzipSync } from 'fflate'
import { readMetashapeXml } from './metashapeXml.js'
import { parsePly } from './ply.js'
import {
  metashapeMeshToModel,
  metashapeTiePoints,
  psxChunkPaths,
  readPlyVertices,
  readPointCloudDoc,
  readPsxChunk,
} from './metashapeProject.js'

// tests/fixtures/metashape/aukerman-tiepoints.psz: Metashape 2.2.2, six Aukerman photos
// matched at a quarter of their size, three aligned, a marker, depth maps, a mesh; the
// .psz with its doc.xml, tie points and mesh only (README.md).
const zip = unzipSync(
  new Uint8Array(readFileSync(new URL('../../../tests/fixtures/metashape/aukerman-tiepoints.psz', import.meta.url))),
)
const doc = readMetashapeXml(new TextDecoder().decode(zip['doc.xml']))
const chunk = doc.chunks[0]
const pc = chunk.frames[0].pointCloud
const read = () =>
  metashapeTiePoints(chunk, {
    tracks: readPlyVertices(zip[pc.tracks]),
    points: pc.points.map((p) => ({ componentId: p.componentId, ply: readPlyVertices(zip[p.path]) })),
    projections: pc.projections.map((p) => ({ cameraId: p.cameraId, ply: readPlyVertices(zip[p.path]) })),
  })

const reprojection = (model, distort = null) => {
  const errs = []
  for (const p of model.points)
    for (const v of p.views) {
      const im = model.images[v.imageId]
      const c = im.R.map((row, i) => row[0] * p.xyz[0] + row[1] * p.xyz[1] + row[2] * p.xyz[2] + im.t[i])
      const [u, w] = distort
        ? distort(c[0] / c[2], c[1] / c[2])
        : [(im.K.fx * c[0]) / c[2] + im.K.cx, (im.K.fy * c[1]) / c[2] + im.K.cy]
      errs.push(Math.hypot(u - v.x, w - v.y))
    }
  errs.sort((a, b) => a - b)
  return { median: errs[errs.length >> 1], p90: errs[Math.floor(errs.length * 0.9)], max: errs.at(-1), n: errs.length }
}

describe('a Metashape project', () => {
  it('reads the frame of a .psz: tie points, mesh, and the products it cannot read', () => {
    expect(pc.projections).toHaveLength(6)
    expect(chunk.frames[0].model.mesh).toBe('model0.ply')
    expect(chunk.frames[0].has).toEqual({ depthMaps: true, denseCloud: true, elevation: false, orthomosaic: false })
    expect(chunk.markers[0].locations).toEqual([{ cameraId: '0', x: 1000, y: 800, pinned: true }])
  })

  it('gives keypoints for every photo, and matches between photos sharing a track', () => {
    const r = read()
    expect(r.counts).toEqual({
      photos: 6,
      keypoints: 758,
      tracks: 367,
      pairs: 10,
      matches: 416,
      points: 169,
      aligned: 3,
    })
    expect(r.keypoints.map((k) => k.label)).toEqual([
      'DSC00290',
      'DSC00291',
      'DSC00292',
      'DSC00293',
      'DSC00294',
      'DSC00295',
    ])
    // Unaligned photos keep their keypoints and matches too.
    expect(r.pairs.some((p) => p.a === 'DSC00293' && p.b === 'DSC00294')).toBe(true)
  })

  it("places cameras and points so Metashape's own residuals come back exactly", () => {
    const r = read()
    // Metashape 2.2.2's camera.project on this project (distortion included), against
    // the same 349 projections: median 0.856, p90 2.195, max 11.175 px.
    const cal = chunk.sensors[0].calibration
    const distort = (x, y) => {
      const r2 = x * x + y * y
      const rad = 1 + cal.k1 * r2 + cal.k2 * r2 * r2 + cal.k3 * r2 ** 3
      const xd = x * rad + cal.p1 * (r2 + 2 * x * x) + 2 * cal.p2 * x * y
      const yd = y * rad + cal.p2 * (r2 + 2 * y * y) + 2 * cal.p1 * x * y
      return [cal.width / 2 + cal.cx + xd * cal.f - 0.5, cal.height / 2 + cal.cy + yd * cal.f - 0.5]
    }
    const e = reprojection(r.model, distort)
    expect(e.n).toBe(349)
    expect(e.median).toBeCloseTo(0.856, 3)
    expect(e.p90).toBeCloseTo(2.195, 3)
    expect(e.max).toBeCloseTo(11.175, 3)
    // In metres: the two first photos were taken some 60 m apart.
    const centre = (im) => im.R[0].map((_, j) => -(im.R[0][j] * im.t[0] + im.R[1][j] * im.t[1] + im.R[2][j] * im.t[2]))
    const [a, b] = r.model.images.map(centre)
    expect(Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2])).toBeGreaterThan(30)
    expect(Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2])).toBeLessThan(120)
  })

  it('puts the mesh in the frame of the sparse model', () => {
    const r = read()
    const mesh = metashapeMeshToModel(
      chunk,
      parsePly(zip['model0.ply'].buffer.slice(zip['model0.ply'].byteOffset)),
      r.model.images[0].componentId,
    )
    expect(mesh.count).toBe(535)
    // The mesh lies among the tie points: its centre within the points' extent.
    const mean = (arr, k, n) => {
      let s = 0
      for (let i = k; i < arr.length; i += 3) s += arr[i]
      return s / n
    }
    const pts = r.model.points.map((p) => p.xyz)
    for (let k = 0; k < 3; k++) {
      const lo = Math.min(...pts.map((p) => p[k])),
        hi = Math.max(...pts.map((p) => p[k]))
      const m = mean(mesh.pos, k, mesh.nVerts)
      expect(m).toBeGreaterThan(lo - 0.2 * (hi - lo))
      expect(m).toBeLessThan(hi + 0.2 * (hi - lo))
    }
  })

  it('assembles a .psx chunk from its chunk and frame documents', () => {
    const chunkXml = `<chunk label="C"><sensors/><cameras><camera id="0" label="A" sensor_id="0"/></cameras><markers><marker id="0" label="M"/></markers><frames><frame id="0" path="0/frame.zip"/></frames></chunk>`
    const frameXml = `<frame><markers><marker marker_id="0"><location camera_id="0" x="1" y="2" pinned="true"/></marker></markers><point_cloud path="point_cloud/point_cloud.zip"/><model id="0" path="model/model.zip"/></frame>`
    const c = readPsxChunk(chunkXml, (p) => (p === '0/frame.zip' ? frameXml : null))
    expect(c.markers[0].locations).toEqual([{ cameraId: '0', x: 1, y: 2, pinned: true }])
    expect(c.frames[0].pointCloud.path).toBe('point_cloud/point_cloud.zip')
    expect(c.frames[0].model.path).toBe('model/model.zip')
    expect(
      psxChunkPaths(
        '<document><chunks active_id="1"><chunk id="0" path="0/chunk.zip"/><chunk id="1" path="1/chunk.zip"/></chunks></document>',
      ),
    ).toEqual(['1/chunk.zip', '0/chunk.zip'])
    expect(
      readPointCloudDoc(
        '<point_cloud><tracks path="tracks.ply"/><points component_id="0" path="points0.ply"/><projections camera_id="3" path="p3.ply"/></point_cloud>',
      ),
    ).toEqual({
      tracks: 'tracks.ply',
      points: [{ componentId: '0', path: 'points0.ply' }],
      projections: [{ cameraId: '3', path: 'p3.ply' }],
    })
  })
})
