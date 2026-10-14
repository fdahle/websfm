// The 2D map's grid layer: OL's graticule for a geographic CRS, our own
// projected grid (core/mapGrid.js) otherwise. On a geographic CRS the projected
// grid and the meridians/parallels are the same lines, so drawing ours would be a
// worse-labelled duplicate. Either way the caller gets one `{ layer, update }`
// controller per built map, and the one `showGrid` toggle drives `layer`.

import VectorLayer from 'ol/layer/Vector'
import VectorSource from 'ol/source/Vector'
import Graticule from 'ol/layer/Graticule'
import Feature from 'ol/Feature'
import Point from 'ol/geom/Point'
import LineString from 'ol/geom/LineString'
import { Style, Fill, Stroke, Text } from 'ol/style'
import { computeGrid, formatGridLabel, gridUnitFor, gridViewKey } from '../../../core/mapGrid.js'

const GRID_STROKE = new Stroke({ color: 'rgba(140,140,140,0.45)', width: 1 })
const GRID_LINE_STYLE = new Style({ stroke: GRID_STROKE })

function makeGridLabel(coord, text, align) {
  const f = new Feature(new Point(coord))
  f.setStyle(new Style({
    text: new Text({
      text,
      font: '11px sans-serif',
      textAlign: align,
      textBaseline: 'bottom',
      offsetX: align === 'left' ? 4 : 0,
      offsetY: -3,
      fill: new Fill({ color: 'rgba(140,140,140,0.95)' }),
      // Halo: the grid runs over basemap imagery, which can be any brightness.
      stroke: new Stroke({ color: 'rgba(0,0,0,0.55)', width: 3 }),
    }),
  }))
  return f
}

/**
 * Build whichever grid the frame calls for. `info` is the frame's crsInfo (or the
 * model frame's stand-in: `gridUnit`, `gridAxes`), `projection` the view's OL
 * projection. Returns `{ layer, update(map) }`; `update` regenerates the projected
 * grid for the map's current view and is a no-op for the graticule, which OL keeps
 * up to date itself.
 */
export function makeGridLayer(info, projection, visible) {
  if (info.geographic || projection?.getUnits() === 'degrees') {
    return {
      layer: new Graticule({
        strokeStyle: GRID_STROKE,
        showLabels: true,
        wrapX: false,
        visible,
      }),
      update() {},
    }
  }

  const source = new VectorSource({ features: [], wrapX: false })
  const validExtent = projection?.getExtent() || info.extent || null
  // The projection's own linear unit; labels are in it, unscaled.
  const units = gridUnitFor(info, projection?.getUnits())
  // Axis letters: easting/northing for a CRS; plain X/Y for the model frame, whose
  // "north" is wherever the auto frame put it, not geographic north.
  const axes = info.gridAxes ?? ['E', 'N']
  let viewKey = '' // last center/resolution the grid was generated for

  const layer = new VectorLayer({
    source,
    style: GRID_LINE_STYLE,       // labels carry their own per-feature style
    visible,
    updateWhileAnimating: true,   // the grid should track the map, not snap in after it
    updateWhileInteracting: true,
  })

  // Driven from `postrender`, i.e. once per animation frame while the map moves,
  // so the edge-pinned labels track the pan/zoom continuously instead of jumping
  // at `moveend` — the same feel as OL's own graticule. The view key makes an
  // unchanged view a no-op, so an idle map costs nothing.
  function update(map) {
    if (!map) return
    const view = map.getView()
    const resolution = view.getResolution()
    const size = map.getSize()
    if (!resolution || !size) return

    const center = view.getCenter() || [0, 0]
    const key = gridViewKey(center, resolution, size)
    if (key === viewKey) return
    viewKey = key

    const grid = computeGrid({ viewExtent: view.calculateExtent(size), resolution, size, validExtent })
    if (!grid) { source.clear(true); return }
    const { bounds, spacing, xs, ys, labelX, labelY } = grid

    const features = []
    for (const x of xs) {
      features.push(new Feature(new LineString([[x, bounds[1]], [x, bounds[3]]])))
      features.push(makeGridLabel([x, labelY], formatGridLabel(x, spacing, axes[0], units), 'center'))
    }
    for (const y of ys) {
      features.push(new Feature(new LineString([[bounds[0], y], [bounds[2], y]])))
      features.push(makeGridLabel([labelX, y], formatGridLabel(y, spacing, axes[1], units), 'left'))
    }

    source.clear(true)
    source.addFeatures(features)
  }

  return { layer, update }
}
