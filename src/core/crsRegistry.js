// Searchable EPSG coordinate-reference-system registry.
//
// The full index is deliberately loaded on demand: most sessions never open a
// CRS picker, and parsing several thousand records during application startup
// would be wasteful. Only horizontal CRSs are offered because WebSfM's working
// CRS is an x/y system; vertical-only and geocentric CRSs cannot be used safely.
import registryUrl from 'epsg-index/all.json?url'

const HORIZONTAL_KINDS = new Set(['CRS-PROJCRS', 'CRS-GEOGCRS', 'CRS-GEOG3DCRS'])

let registryPromise = null

function worldExtent(bbox) {
  // epsg-index stores [north, west, south, east].
  if (!Array.isArray(bbox) || bbox.length !== 4 || bbox.some((n) => !Number.isFinite(n))) return undefined
  return [bbox[1], bbox[2], bbox[3], bbox[0]]
}

export function normaliseCrsRecord(record) {
  return {
    code: `EPSG:${record.code}`,
    name: record.name || `EPSG:${record.code}`,
    area: record.area || '',
    unit: record.unit || '',
    def: record.proj4 || record.wkt || '',
    geographic: record.kind === 'CRS-GEOGCRS' || record.kind === 'CRS-GEOG3DCRS',
    worldExtent: worldExtent(record.bbox),
  }
}

export async function loadCrsRegistry() {
  if (!registryPromise) {
    // Keep the catalog as a static JSON asset. Bundling it as an object-literal
    // JavaScript chunk inflated it and triggered the large-chunk warning even though
    // it was already lazy. The hashed local URL remains offline-capable.
    registryPromise = fetch(registryUrl).then((response) => {
      if (!response.ok) throw new Error(`Could not load the CRS catalog (${response.status})`)
      return response.json()
    }).then((index) =>
      Object.values(index)
        .filter((record) => HORIZONTAL_KINDS.has(record.kind) && (record.proj4 || record.wkt))
        .map(normaliseCrsRecord),
    )
  }
  return registryPromise
}

function searchable(record) {
  return `${record.code} ${record.name} ${record.area}`.toLocaleLowerCase()
}

// Rank exact code/name matches first, then prefixes, then general token matches.
// Requiring every token makes searches such as "wgs 84 netherlands" useful
// without flooding the result list.
export function searchCrsRecords(records, query, limit = 12) {
  const q = query.trim().toLocaleLowerCase().replace(/^epsg\s*:\s*/, '')
  if (!q) return records.slice(0, limit)
  const tokens = q.split(/\s+/).filter(Boolean)

  return records
    .map((record) => {
      const code = record.code.replace(/^EPSG:/i, '').toLocaleLowerCase()
      const name = record.name.toLocaleLowerCase()
      const text = searchable(record)
      if (!tokens.every((token) => text.includes(token))) return null
      let score = 4
      if (code === q) score = 0
      else if (name === q) score = 1
      else if (code.startsWith(q)) score = 2
      else if (name.startsWith(q)) score = 3
      return { record, score }
    })
    .filter(Boolean)
    .sort((a, b) => a.score - b.score || a.record.name.localeCompare(b.record.name))
    .slice(0, limit)
    .map(({ record }) => record)
}
