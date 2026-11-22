import { expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { unzlibSync } from 'fflate'
import {
  geoidGrid,
  geoidNodes,
  datumShift,
  isConvertible,
  loadGeoid,
  heightShifter,
  GEOID_GRIDS,
} from './verticalDatum.js'

const read = (file) => readFileSync(new URL(`../../public/geoid/${file}`, import.meta.url))
const grid = (datum) => {
  const shape = GEOID_GRIDS[datum]
  return geoidGrid(geoidNodes(unzlibSync(read(shape.file)), shape), shape)
}
const egm96 = grid('geoid:EGM96'),
  egm2008 = grid('geoid:EGM2008')

// N = −H from PROJ 9 (cs2cs EPSG:4979 → EPSG:4326+5773 / +3855 at h = 0), against
// NGA's full grids: EGM96 at 15′ (the same nodes), EGM2008 at 2.5′.
const PROJ = [
  // [lat, lon, N EGM96, N EGM2008]
  [0, 0, 17.1616, 17.2251],
  [-75, 0, 9.2582, 11.7382],
  [-77.85, 166.67, -53.3815, -52.4734],
  [-90, 0, -29.5338, -30.15],
  [47.37, 8.54, 47.3412, 47.7185],
  [27.99, 86.93, -28.8575, -28.3921],
  [-80, -120, -38.9727, -38.5448],
  [60, -179.9, 0.5944, 0.9824],
  [-64.5, -62, 17.695, 19.781],
]

it('interpolates the geoid like PROJ: EGM96 to the centimetre grid, EGM2008 within its 5′ reduction', () => {
  for (const [lat, lon, n96, n08] of PROJ) {
    expect(Math.abs(egm96.undulation(lon, lat) - n96)).toBeLessThan(0.006)
    // Bicubic between 5′ nodes of the 2.5′ model, even under Everest. (The 15′ grid
    // read bilinearly, shipped until 0.9, was 36 cm off there.)
    expect(Math.abs(egm2008.undulation(lon, lat) - n08)).toBeLessThan(0.03)
  }
  // At a node, the node: the Int16 centimetres of the source grid.
  expect(egm2008.undulation(0, 0)).toBeCloseTo(17.23, 2)
  // Longitude wraps: 180° E is 180° W.
  expect(egm96.undulation(180, -70)).toBeCloseTo(egm96.undulation(-180, -70), 9)
  expect(egm96.undulation(179.9, 60)).toBeCloseTo(egm96.undulation(-180.1, 60), 9)
})

it('shifts heights between ellipsoid and geoids, and refuses what it cannot convert', () => {
  const grids = { 'geoid:EGM96': egm96, 'geoid:EGM2008': egm2008 }
  // McMurdo: the geoid lies ~53 m below the ellipsoid, so H = h + 53.
  const h2H = datumShift('ellipsoidal', 'geoid:EGM96', 166.67, -77.85, grids)
  expect(h2H).toBeCloseTo(53.38, 1)
  expect(datumShift('geoid:EGM96', 'ellipsoidal', 166.67, -77.85, grids)).toBeCloseTo(-h2H, 12)
  expect(datumShift('geoid:EGM96', 'geoid:EGM2008', 166.67, -77.85, grids)).toBeCloseTo(-53.38 + 52.47, 1)
  expect(datumShift('orthometric', 'orthometric', 0, 0, grids)).toBe(0)
  expect(datumShift('orthometric', 'ellipsoidal', 0, 0, grids)).toBeNull()
  expect(datumShift('unknown', 'geoid:EGM96', 0, 0, grids)).toBeNull()
  expect(['ellipsoidal', 'geoid:EGM96', 'geoid:EGM2008', 'local'].map(isConvertible)).toEqual([true, true, true, false])
})

it('loads a grid once over fetch and converts many points with one shifter', async () => {
  let fetches = 0
  const fetchImpl = async () => {
    fetches++
    const b = read('egm96-15.i16.z')
    return { ok: true, arrayBuffer: async () => b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength) }
  }
  const g = await loadGeoid('geoid:EGM96', { fetchImpl })
  await loadGeoid('geoid:EGM96', { fetchImpl })
  expect(fetches).toBe(1)
  expect(g.undulation(0, 0)).toBeCloseTo(17.16, 2)
  const shift = await heightShifter('geoid:EGM96', 'ellipsoidal')
  expect(shift(0, 0)).toBeCloseTo(17.16, 2)
  expect(await heightShifter('local', 'ellipsoidal')).toBeNull()
  expect((await heightShifter('local', 'local'))(5, 5)).toBe(0)
})

it('formats the range of a conversion shift', async () => {
  const { shiftRange } = await import('./verticalDatum.js')
  expect(shiftRange({ min: 53.381, max: 53.384 })).toBe('+53.38 m')
  expect(shiftRange({ min: -1.5, max: 2.25 })).toBe('−1.50 to +2.25 m')
})
