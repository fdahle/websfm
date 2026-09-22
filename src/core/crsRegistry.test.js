import { describe, expect, it, vi } from 'vitest'
import { loadCrsRegistry, normaliseCrsRecord, searchCrsRecords } from './crsRegistry.js'
import { axisLabels, crsInfo, ensureProjection } from './crs.js'

const records = [
  { code: 'EPSG:4326', name: 'WGS 84', area: 'World', unit: 'degree' },
  { code: 'EPSG:28992', name: 'Amersfoort / RD New', area: 'Netherlands - onshore', unit: 'metre' },
  { code: 'EPSG:32632', name: 'WGS 84 / UTM zone 32N', area: 'Europe', unit: 'metre' },
]

describe('searchCrsRecords', () => {
  it('searches by numeric EPSG code with or without the authority prefix', () => {
    expect(searchCrsRecords(records, '28992')[0].code).toBe('EPSG:28992')
    expect(searchCrsRecords(records, 'EPSG:4326')[0].code).toBe('EPSG:4326')
  })

  it('searches names and areas using all query tokens', () => {
    expect(searchCrsRecords(records, 'rd netherlands')[0].code).toBe('EPSG:28992')
    expect(searchCrsRecords(records, 'wgs europe')[0].code).toBe('EPSG:32632')
  })

  it('ranks an exact code above other matches', () => {
    expect(searchCrsRecords(records, '4326').map((r) => r.code)).toEqual(['EPSG:4326'])
  })
})

describe('normaliseCrsRecord', () => {
  it('normalises codes and converts the EPSG index bbox to a world extent', () => {
    expect(normaliseCrsRecord({
      code: '28992', name: 'Amersfoort / RD New', kind: 'CRS-PROJCRS',
      proj4: '+proj=sterea', bbox: [53.7, 3.2, 50.7, 7.3],
    })).toMatchObject({
      code: 'EPSG:28992', geographic: false, worldExtent: [3.2, 50.7, 7.3, 53.7],
    })
  })

  it('passes registry metadata into the shared CRS helpers', async () => {
    const record = normaliseCrsRecord({
      code: '999002', name: 'Test geographic CRS', kind: 'CRS-GEOGCRS',
      proj4: '+proj=longlat +datum=WGS84 +no_defs', bbox: [90, -180, -90, 180],
    })
    await ensureProjection(record.code, record)
    expect(crsInfo(record.code).name).toBe('Test geographic CRS')
    expect(axisLabels(record.code)).toEqual(['Lon', 'Lat', 'Alt'])
  })
})

describe('loadCrsRegistry', () => {
  it('fetches and filters the emitted catalog asset on demand', async () => {
    const fetchMock = vi.fn(async () => ({
      ok: true,
      json: async () => ({
        1: { code: '1', name: 'Projected', kind: 'CRS-PROJCRS', proj4: '+proj=utm' },
        2: { code: '2', name: 'Vertical', kind: 'CRS-VERTCRS', wkt: 'VERT_CS[]' },
      }),
    }))
    vi.stubGlobal('fetch', fetchMock)
    const loaded = await loadCrsRegistry()
    expect(fetchMock).toHaveBeenCalledOnce()
    expect(loaded.map((record) => record.code)).toEqual(['EPSG:1'])
    vi.unstubAllGlobals()
  })
})
