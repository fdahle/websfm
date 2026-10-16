// What the service worker keeps for offline use beyond the app itself: the
// ONNX Runtime wasm (on first use) and basemap tiles the user has already viewed.
// Pure data, imported by vite.config.js, which hands it to Workbox. Workbox
// serialises these RegExps into the generated sw.js, so they must stay
// self-contained (no flags beyond `i`, no references to other values).
//
// Tiles: only levels up to TILE_CACHE_MAX_ZOOM, and only what was actually
// viewed. Never prefetch: OpenStreetMap's tile policy forbids bulk downloading,
// and Esri's terms restrict offline use of World Imagery. Offline, the map's
// basemap layers preload lower levels (map/mapBasemaps.js), so a project area seen
// before comes back as a coarser, upsampled image instead of a blank map.
// A user-defined satellite source (Settings) is not cached: its URL template,
// and therefore where the zoom level sits in it, is unknown.

export const TILE_CACHE_MAX_ZOOM = 12

// 0–12 as a path segment.
const Z = '(?:\\d|1[0-2])'

const DAY = 24 * 60 * 60

// One cache per source, each with its own size cap (oldest entries go first).
// The caps bound the worst case at roughly 50 MB: OSM and satellite tiles are
// ~20–30 KB, terrain PNGs ~60–80 KB, the polar layers ~30 KB.
export const TILE_CACHES = [
  {
    name: 'websfm-tiles-osm',
    pattern: new RegExp(`^https://(?:[abc]\\.)?tile\\.openstreetmap\\.org/${Z}/\\d+/\\d+\\.png$`),
    maxEntries: 500,
  },
  {
    name: 'websfm-tiles-satellite',
    pattern: new RegExp(`^https://server\\.arcgisonline\\.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/${Z}/\\d+/\\d+$`),
    maxEntries: 500,
  },
  {
    name: 'websfm-tiles-terrain',
    pattern: new RegExp(`^https://s3\\.amazonaws\\.com/elevation-tiles-prod/terrarium/${Z}/\\d+/\\d+\\.png$`),
    maxEntries: 300,
  },
  {
    // NASA GIBS polar mosaics have only a handful of levels, all coarse, so every
    // level qualifies. KVP (…REQUEST=GetTile…) and REST (…/z/row/col.png) forms.
    name: 'websfm-tiles-polar',
    pattern: /^https:\/\/gibs\.earthdata\.nasa\.gov\/wmts\/.*(?:REQUEST=GetTile|\/\d+\/\d+\/\d+\.(?:png|jpe?g)$)/i,
    maxEntries: 300,
  },
].map((cache) => ({ ...cache, maxAgeSeconds: 30 * DAY }))

// The polar layer's WMTS capabilities: refreshed when online, served from cache
// offline so the cached polar tiles can still be placed.
export const GIBS_CAPABILITIES = {
  name: 'websfm-tiles-polar-capabilities',
  pattern: /^https:\/\/gibs\.earthdata\.nasa\.gov\/wmts\/.*REQUEST=GetCapabilities/i,
  maxEntries: 4,
}

// ONNX Runtime's wasm runtime: one variant (of four, ~25 MB each) is fetched,
// picked by browser features, so it is cached on first use rather than
// precached. The paths are versioned or content-hashed, so a cached copy never
// goes stale.
export const ORT_RUNTIME = {
  name: 'websfm-ort-runtime',
  pattern: /\/ort-wasm[^/]*\.(?:wasm|mjs)$/,
  maxEntries: 8,
}

/** The tile cache a URL belongs in, or null (wrong source or too detailed a level). */
export function tileCacheFor(url) {
  return TILE_CACHES.find((cache) => cache.pattern.test(url)) ?? null
}
