import { describe, it, expect } from 'vitest'
import {
  s2SearchBody,
  s2Scenes,
  rankScenes,
  sceneWindow,
  stretchBands,
  lonLatBbox,
  bboxCoverage,
  s2RasterName,
  s2Attribution,
} from './sentinel2.js'

// The shape of an Earth Search v1 item (trimmed from a real answer over Neko Harbour).
const square = (w, s, e, n) => ({
  type: 'Polygon',
  coordinates: [
    [
      [w, s],
      [e, s],
      [e, n],
      [w, n],
      [w, s],
    ],
  ],
})
const band = (name) => ({
  'href': `https://sentinel-cogs.example/T20DNP/${name}.tif`,
  'proj:shape': [10980, 10980],
  'proj:transform': [10, 0, 499980, 0, -10, 2900020],
})
const item = (id, props, geometry = square(-63, -65, -60.7, -64)) => ({
  id,
  geometry,
  properties: {
    'datetime': '2025-03-23T13:20:36.123Z',
    'grid:code': 'MGRS-20DNP',
    'proj:epsg': 32720,
    'eo:cloud_cover': 2.2,
    's2:snow_ice_percentage': 44.3,
    's2:nodata_pixel_percentage': 0,
    ...props,
  },
  assets: { red: band('B04'), green: band('B03'), blue: band('B02'), visual: { href: 'tci' } },
})

describe('s2SearchBody', () => {
  it('asks for L2A scenes over the box, under the cloud limit, least cloudy first', () => {
    const b = s2SearchBody({ bbox: [1, 2, 3, 4], maxCloud: 10 })
    expect(b).toMatchObject({
      collections: ['sentinel-2-l2a'],
      bbox: [1, 2, 3, 4],
      query: { 'eo:cloud_cover': { lt: 10 } },
    })
    expect(b.datetime).toBeUndefined()
    expect(s2SearchBody({ bbox: [], from: '2020-01-01' }).datetime).toBe('2020-01-01T00:00:00Z/..')
    expect(s2SearchBody({ bbox: [], from: '2020-01-01', to: '2021-02-03' }).datetime).toBe(
      '2020-01-01T00:00:00Z/2021-02-03T23:59:59Z',
    )
  })
})

describe('s2Scenes and rankScenes', () => {
  it('reads date, tile, cloud, projection and the RGB hrefs; skips items without them', () => {
    const fc = { features: [item('a', {}), { ...item('b', {}), assets: { red: band('B04') } }] }
    const [s] = s2Scenes(fc, [-62.6, -64.9, -62.4, -64.8])
    expect(s).toMatchObject({ id: 'a', date: '2025-03-23', tile: '20DNP', cloud: 2.2, snow: 44.3, epsg: 32720 })
    expect(s.coverage).toBe(1)
    expect(s.hrefs.green).toMatch(/B03\.tif$/)
    expect(s2Scenes(fc, null)).toHaveLength(1)
  })

  it('puts a scene covering the whole area first, then the least cloud, then the newest', () => {
    const bbox = [-62.6, -64.9, -62.4, -64.8]
    const fc = {
      features: [
        item('partial', { 'eo:cloud_cover': 0 }, square(-62.5, -65, -60, -64)),
        item('cloudy', { 'eo:cloud_cover': 9 }),
        item('old', { 'eo:cloud_cover': 1, 'datetime': '2019-01-01T00:00:00Z' }),
        item('new', { 'eo:cloud_cover': 1, 'datetime': '2024-01-01T00:00:00Z' }),
      ],
    }
    expect(rankScenes(s2Scenes(fc, bbox)).map((s) => s.id)).toEqual(['new', 'old', 'cloudy', 'partial'])
  })

  it('measures coverage on a grid, holes excluded', () => {
    expect(bboxCoverage(square(0, 0, 1, 1), [0, 0, 2, 1])).toBeCloseTo(4 / 9, 5) // 4 of 9 column centres below 1
    const holed = {
      type: 'Polygon',
      coordinates: [square(0, 0, 3, 3).coordinates[0], square(1, 1, 2, 2).coordinates[0]],
    }
    expect(bboxCoverage(holed, [1, 1, 2, 2])).toBe(0)
    expect(bboxCoverage({ type: 'MultiPolygon', coordinates: [square(0, 0, 1, 1).coordinates] }, [0, 0, 1, 1])).toBe(1)
  })

  it('names the raster and attributes Copernicus', () => {
    expect(s2RasterName({ date: '2025-03-23', tile: '20DNP' })).toBe('Sentinel-2 2025-03-23 20DNP.tif')
    expect(s2Attribution(2025)).toBe('Contains modified Copernicus Sentinel data 2025')
    expect(
      lonLatBbox([
        [1, 2],
        [3, -1],
        [NaN, 0],
      ]),
    ).toEqual([1, -1, 3, 2])
  })
})

describe('sceneWindow', () => {
  const T = [10, 0, 499980, 0, -10, 2900020],
    shape = [10980, 10980]
  it('pads the area by a quarter (at least the minimum) and gives the window origin', () => {
    // A 4 km square from (510000, 2880000) to (514000, 2884000): padded by 1 km.
    const w = sceneWindow(T, shape, [
      [510000, 2880000],
      [514000, 2884000],
    ])
    expect(w).toEqual({ x: 902, y: 1502, width: 600, height: 600, originX: 509000, originY: 2885000, res: 10 })
    const big = sceneWindow(
      T,
      shape,
      [
        [510000, 2860000],
        [530000, 2880000],
      ],
      { maxPx: 10000 },
    )
    expect(big.width).toBe(3000) // 20 km + 2 × 5 km
  })

  it('clips to the scene, and refuses an area outside it or too large', () => {
    const w = sceneWindow(T, shape, [[500000, 2900000]])
    expect([w.x, w.y]).toEqual([0, 0])
    expect(() => sceneWindow(T, shape, [[100000, 100000]])).toThrow(/outside this scene/)
    expect(() =>
      sceneWindow(T, shape, [
        [500000, 2800000],
        [580000, 2880000],
      ]),
    ).toThrow(/km across/)
  })
})

describe('stretchBands', () => {
  it('stretches all three bands together between the quantiles, keeping 0 as no data', () => {
    const r = Uint16Array.from([0, 1000, 5000, 9000]),
      g = Uint16Array.from([0, 1000, 5000, 15000]),
      b = Uint16Array.from([0, 1000, 5000, 3000])
    const { rgb, lo, hi } = stretchBands([r, g, b], { loQ: 0, hiQ: 1 })
    expect([lo, hi]).toEqual([1000, 15000])
    expect(Array.from(rgb.slice(0, 3))).toEqual([0, 0, 0])
    expect(Array.from(rgb.slice(3, 6))).toEqual([1, 1, 1])
    expect(rgb[3 * 3 + 1]).toBe(255) // snow at the top of the range, not clipped below it
    expect(rgb[3 * 2]).toBe(1 + Math.round((4000 * 254) / 14000))
  })
})
