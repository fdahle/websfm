import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import proj4 from 'proj4'
import {
  readMetashapeXml,
  readChunkCrs,
  metashapeChunkToImport,
  metashapeSensor,
  ellipsoidOf,
  geographicDefOf,
  geocentricToGeodetic,
  scaleSensorTo,
} from './metashapeXml.js'
import { opkMatrix } from '../footprint.js'

const fixture = (name) => readFileSync(new URL(`../../../tests/fixtures/metashape/${name}`, import.meta.url), 'utf8')
const UTM17 = '+proj=utm +zone=17 +datum=WGS84 +units=m +no_defs'
const WGS84 = '+proj=longlat +datum=WGS84 +no_defs'

describe('readMetashapeXml', () => {
  const doc = readMetashapeXml(fixture('aukerman-markers.xml'))
  const chunk = doc.chunks[0]

  it('reads the sensors, cameras, components and markers with their marks', () => {
    expect(doc.version).toBe('2.0.0')
    expect(chunk.crs).toMatchObject({ epsg: 'EPSG:4326', local: false, verticalDatum: 'ellipsoidal' })
    expect(chunk.sensors).toHaveLength(1)
    expect(chunk.sensors[0]).toMatchObject({ label: 'DSC-WX220 (4.45mm)', type: 'frame', width: 2400, height: 1800 })
    expect(chunk.sensors[0].calibration).toMatchObject({ class: 'adjusted', f: 1776.9135451498098, k4: 0 })
    expect(chunk.cameras).toHaveLength(42)
    expect(chunk.cameras.every((c) => c.transform?.length === 16 && c.componentId === '0')).toBe(true)
    expect(chunk.components.get('0').s).toBeCloseTo(21.691, 3)
    expect(chunk.markers.map((m) => [m.label, m.reference.enabled])).toEqual([
      ['GCP1', true],
      ['GCP2', true],
      ['GCP3', false],
    ])
    expect(chunk.markers[0].locations[0]).toEqual({ cameraId: '2', x: 104.079048, y: 1020.72284, pinned: true })
  })

  it('refuses a file that is not a Metashape document', () => {
    expect(() => readMetashapeXml('<kml></kml>')).toThrow(/Not a Metashape XML/)
    expect(() => readMetashapeXml('<document version="2.0.0"/>')).toThrow(/no chunk/)
  })
})

describe('readChunkCrs', () => {
  it('names the horizontal EPSG code and the vertical datum of a compound CRS', () => {
    const compound =
      'COMPD_CS["WGS 84 + EGM96 height",GEOGCS["WGS 84",DATUM["WGS_1984",SPHEROID["WGS 84",6378137,298.257223563,' +
      'AUTHORITY["EPSG","7030"]],AUTHORITY["EPSG","6326"]],PRIMEM["Greenwich",0,AUTHORITY["EPSG","8901"]],' +
      'UNIT["degree",0.0174532925199433,AUTHORITY["EPSG","9102"]],AUTHORITY["EPSG","4326"]],' +
      'VERT_CS["EGM96 height",VERT_DATUM["EGM96 geoid",2005,AUTHORITY["EPSG","5171"]],AUTHORITY["EPSG","5773"]]]'
    expect(readChunkCrs(compound)).toMatchObject({ epsg: 'EPSG:4326', verticalDatum: 'geoid:EGM96', local: false })
    expect(readChunkCrs('LOCAL_CS["Local Coordinates (m)",LOCAL_DATUM["Local Datum",0]]')).toMatchObject({
      epsg: null,
      local: true,
    })
    expect(readChunkCrs('')).toMatchObject({ local: true })
  })
})

describe('geodesy helpers', () => {
  it('reads the ellipsoid and the geographic definition of a proj4 string', () => {
    expect(ellipsoidOf(UTM17)).toEqual({ a: 6378137, f: 1 / 298.257223563 })
    expect(ellipsoidOf('+proj=somerc +ellps=bessel +towgs84=674.374,15.056,405.346')).toEqual({
      a: 6377397.155,
      f: 1 / 299.1528128,
    })
    expect(ellipsoidOf('+proj=tmerc')).toBeNull()
    expect(geographicDefOf('+proj=somerc +lat_0=46.9 +ellps=bessel +towgs84=674.374,15.056,405.346 +units=m')).toBe(
      '+proj=longlat +ellps=bessel +towgs84=674.374,15.056,405.346 +no_defs',
    )
  })

  it('turns geocentric coordinates into longitude, latitude and height', () => {
    const wgs = ellipsoidOf(UTM17)
    const [lon, lat, h] = geocentricToGeodetic([688370.3956, -4748974.1729, 4188100.6355], wgs)
    // Back through the closed-form forward conversion.
    const a = wgs.a,
      e2 = wgs.f * (2 - wgs.f),
      la = (lat * Math.PI) / 180,
      lo = (lon * Math.PI) / 180
    const N = a / Math.sqrt(1 - e2 * Math.sin(la) ** 2)
    expect((N + h) * Math.cos(la) * Math.cos(lo)).toBeCloseTo(688370.3956, 6)
    expect((N + h) * Math.cos(la) * Math.sin(lo)).toBeCloseTo(-4748974.1729, 6)
    expect((N * (1 - e2) + h) * Math.sin(la)).toBeCloseTo(4188100.6355, 6)
  })
})

describe('metashapeSensor', () => {
  it('moves the principal point to pixel centres and exchanges p1 and p2', () => {
    const sensor = readMetashapeXml(fixture('aukerman-markers.xml')).chunks[0].sensors[0]
    const { sensor: s, dropped } = metashapeSensor(sensor, ['DSC00268'])
    const c = sensor.calibration
    expect(s).toMatchObject({ width: 2400, height: 1800, focal: c.f, distortionModel: 'brown', images: ['DSC00268'] })
    expect(s.cx).toBeCloseTo(1200 + c.cx - 0.5, 12)
    expect(s.cy).toBeCloseTo(900 + c.cy - 0.5, 12)
    expect([s.p1, s.p2]).toEqual([c.p2, c.p1])
    expect(s.pixelSize).toBeCloseTo(0.0025671525, 9)
    expect(dropped).toEqual([])
  })

  it('names the terms it cannot keep, and how far they move a corner', () => {
    const base = { label: 'Cam', type: 'frame', width: 4000, height: 3000 }
    const c = {
      width: 4000,
      height: 3000,
      f: 3000,
      cx: 0,
      cy: 0,
      k1: -0.1,
      k2: 0,
      k3: 0,
      k4: 0,
      p1: 0,
      p2: 0,
      p3: 0,
      p4: 0,
    }
    const r = metashapeSensor({ ...base, calibration: { ...c, b1: 0.6, b2: 0 } })
    expect(r.dropped).toEqual(['b1'])
    expect(r.droppedPx).toBeCloseTo(0.6 * (2000 / 3000), 9)
    expect(metashapeSensor({ ...base, type: 'spherical', calibration: c }).skip).toMatch(/spherical/)
    expect(metashapeSensor({ ...base, calibration: null }).skip).toMatch(/no calibration/)
  })
})

describe('metashapeChunkToImport', () => {
  const chunk = readMetashapeXml(fixture('aukerman-markers.xml')).chunks[0]
  const toUtm = proj4(WGS84, UTM17)
  const opts = {
    ellipsoid: ellipsoidOf(UTM17),
    toTarget: (lon, lat) => toUtm.forward([lon, lat]),
    fromChunk: (x, y) => toUtm.forward([x, y]),
    metric: true,
  }
  const out = metashapeChunkToImport(chunk, opts)
  const expected = JSON.parse(fixture('aukerman-opk-utm17n.json')).cameras

  it("places every camera where Metashape's own Omega Phi Kappa export does", () => {
    expect(out.poses).toHaveLength(42)
    let dPos = 0,
      dRot = 0
    for (const p of out.poses) {
      const [E, N, h, om, ph, ka] = expected[p.imageName]
      dPos = Math.max(dPos, Math.abs(p.x - E), Math.abs(p.y - N), Math.abs(p.z - h))
      const A = opkMatrix(p.omega, p.phi, p.kappa),
        B = opkMatrix(om, ph, ka)
      for (let i = 0; i < 3; i++) for (let j = 0; j < 3; j++) dRot = Math.max(dRot, Math.abs(A[i][j] - B[i][j]))
    }
    expect(dPos).toBeLessThan(1e-6)
    expect(dRot).toBeLessThan(1e-8)
    expect(out.poses[0]).toMatchObject({ verticalDatum: 'ellipsoidal', enabled: true })
    expect(out.poses[0].accuracyX).toBeGreaterThan(0)
  })

  it('gives the markers as GCPs with their pinned marks, a disabled one as a check', () => {
    expect(out.gcps.map((g) => [g.name, g.role, g.observations.length])).toEqual([
      ['GCP1', 'control', 17],
      ['GCP2', 'control', 12],
      ['GCP3', 'check', 6],
    ])
    const [E, N] = toUtm.forward([-81.752370943336345, 41.304116404511582])
    expect(out.gcps[0]).toMatchObject({ accuracyX: 0.02, accuracyY: 0.02, accuracyZ: 0.03 })
    expect(out.gcps[0].x).toBeCloseTo(E, 6)
    expect(out.gcps[0].y).toBeCloseTo(N, 6)
    expect(out.gcps[0].observations[0]).toMatchObject({ imageName: 'DSC00272', px: 104.079048, py: 1020.72284 })
    expect(out.sensors).toHaveLength(1)
    expect(out.sensors[0].images).toHaveLength(42)
    expect(out.counts).toEqual({ cameras: 42, aligned: 42, sensors: 1, markers: 3, marks: 35 })
    expect(out.warnings).toEqual([])
  })

  it('keeps the calibration and the marks of a local chunk, and says the poses stay behind', () => {
    const local = { ...chunk, crs: readChunkCrs('LOCAL_CS["Local Coordinates (m)"]') }
    const r = metashapeChunkToImport(local, opts)
    expect(r.poses).toEqual([])
    expect(r.sensors).toHaveLength(1)
    expect(r.gcps.every((g) => g.role === 'marker' && g.x == null && g.observations.length > 0)).toBe(true)
    expect(r.warnings.join(' ')).toMatch(/local frame/)
  })
})

describe('scaleSensorTo', () => {
  const s = { width: 2400, height: 1800, focal: 1777, cx: 1237.2, cy: 882.66, k1: 0.008, pixelSize: 0.00257 }
  it('scales the pixel quantities of a calibration made at another size', () => {
    const half = scaleSensorTo(s, 1200, 900)
    expect(half).toMatchObject({ width: 1200, height: 900, focal: 888.5, k1: 0.008 })
    // Pixel centres: the centre of pixel 0 at full size is at ¼ px of half-size pixel 0.
    expect(half.cx).toBeCloseTo((1237.2 + 0.5) / 2 - 0.5, 12)
    expect(half.pixelSize).toBeCloseTo(0.00514, 12)
    expect(scaleSensorTo(s, 2400, 1800)).toBe(s)
  })
  it('refuses a different aspect', () => {
    expect(scaleSensorTo(s, 1800, 1800)).toBeNull()
  })
})
