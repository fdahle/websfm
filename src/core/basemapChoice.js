// Which base layer a map frame gets, from the user's preference and the frame.
// Pure — components/viewers/map/mapBasemaps.js builds the OpenLayers layer for
// the returned kind; the catalogue itself is core/basemaps.js.

import { BASEMAPS, basemapReason } from './basemaps.js'

/**
 * `choice` is the Basemap preference (BASEMAPS values), `info` the frame's
 * crsInfo (`basemap`: 'osm' | 'gibs' | null), `isModel` whether the map shows the
 * model frame. Returns `{ kind, note }`: kind is 'satellite' | 'terrain' | 'osm' |
 * 'gibs' | null (grid only); note is '' or the line explaining a fallback.
 *
 * "Automatic" preserves the CRS-aware polar layers; an explicit street layer uses
 * OSM everywhere. The model frame has no position on Earth, so it never gets a
 * basemap. A choice this CRS cannot show (greyed in the ribbon) falls back to
 * Automatic.
 */
export function chooseBasemap(choice, info, isModel) {
  if (isModel) return { kind: null, note: '' }
  let note = ''
  if (basemapReason(choice, info)) {
    note = `${BASEMAPS.find((b) => b.value === choice)?.label} base layer is not available for this coordinate system — showing the automatic one.`
    choice = 'auto'
  }
  const kind = choice === 'satellite' ? 'satellite'
    : choice === 'terrain' ? 'terrain'
    : choice === 'streets' || (choice === 'auto' && info.basemap === 'osm') ? 'osm'
    : choice === 'auto' && info.basemap === 'gibs' ? 'gibs'
    : null
  return { kind, note }
}
