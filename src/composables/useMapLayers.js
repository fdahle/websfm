// The 2D map's layer stack: imported DEMs/orthos, computed products and the vector
// layers (contours, imported polygon files), drawn in one list under the project's
// own markers (ViewerMap.vue). Two things make the rasters cheap enough to be a
// toggle rather than a heavyweight mode:
//
//  1. **The fallback renders `previewDataUrl`, never the pixel plane.** The ≤1024 px
//     PNG is already in the index from restore, so showing a REMA tile costs no
//     decode and no memory — `ensureRasterLoaded` is deliberately NOT called here.
//     On a basemap-zoom view the tile is a few hundred screen pixels wide anyway;
//     the full plane exists for *sampling*, and that's a different question.
//  2. **The raster keeps its native CRS** (store invariant 2). We hand OpenLayers
//     the extent in the raster's own projection and let it reproject the image on
//     the fly, so this survives `handleSetCrs` with no resampling — the same
//     reason the sampler reprojects the query instead of warping the raster.
//
// A vector entry (`vector: true`, core/products/vectorLayers.js) is in the project
// CRS, the view's, and becomes an OpenLayers vector layer at its place in the stack.
//
// Lifecycle (driven by ViewerMap's build/destroy): `createGroup()` per build,
// before the map exists; `sync()` whenever `layers()` changes; `dispose()` on
// destroy. The map itself is read from `ctx.map` at call time.

import ImageLayer from 'ol/layer/Image'
import VectorLayer from 'ol/layer/Vector'
import VectorSource from 'ol/source/Vector'
import Static from 'ol/source/ImageStatic'
import LayerGroup from 'ol/layer/Group'
import { get as getOlProjection, transformExtent } from 'ol/proj'
import { useExternalStore } from '../stores/useExternalStore.js'
import { createGpuRasterLayer, gpuRasterStyle, disposeRasterLayer } from '../components/viewers/raster/gpuRaster.js'
import { orthoAdjustFilter } from '../utils/orthoFilter.js'
import { ensureProjection } from '../core/crs.js'
import { rasterBounds } from '../core/io/rasterSample.js'
import { makeFootprintFeature } from '../components/viewers/map/mapFeatures.js'
import { footprintStyle } from '../components/viewers/map/mapStyles.js'

/**
 * `ctx`: the map context (components/viewers/map/mapContext.js). `layers()`: the
 * layers on the map, in stacking order, bottom first. `modelCode()`: the model frame's
 * projection code while the map shows it (registered by build(), so never looked
 * up remotely), else undefined. `selectedId()`: the selected image, which a polygon
 * linked to it is highlighted for.
 */
export function useMapLayers(ctx, { layers: wanted, modelCode, selectedId = () => null }) {
  const external = useExternalStore()
  let group = null
  const layers = new Map() // id → OpenLayers layer
  // Bumped per sync and by dispose(): a sync resuming after an await abandons
  // itself once a newer sync or a teardown has happened.
  let generation = 0

  // A vector layer, tagged with the revision of the features it was built from.
  function makeVectorLayer(v) {
    const layer = new VectorLayer({
      source: new VectorSource({ features: v.features().map(makeFootprintFeature) }),
      style: (f) => footprintStyle(f, selectedId()),
      opacity: v.opacity ?? 1,
    })
    tagVector(layer, v)
    return layer
  }
  function tagVector(layer, v) {
    layer.set('vector', true)
    layer.set('rev', v.rev)
  }

  async function makeRasterLayer(r) {
    if (r.vector) return makeVectorLayer(r)
    // An imported raster draws its tiled display file; a computed ortho (`product:
    // true`, core/products/productLayers.js) its stored COG when the layer carries one.
    // A computed DEM, or a product the COG cannot place here, draws its preview.
    if (r.product ? !!r.cog : [1, 2].includes(r.photometric ?? 1)) {
      try {
        const file = r.product ? r.cog : await external.displayFile(r.id)
        if (file) {
          const layer = await createGpuRasterLayer(r, file)
          layer.set('fileKey', r.fileKey ?? r.id)
          layer.once('postrender', () => {
            r.gpuReady = true
          })
          return layer
        }
      } catch (err) {
        console.warn('Tiled raster display failed; using preview', err)
      }
    }
    const bounds = rasterBounds({ width: r.width, height: r.height, geoTransform: r.geoTransform })
    if (!bounds) return null
    const projection = getOlProjection(r.crs)
    if (!projection) return null
    const layer = new ImageLayer({
      source: new Static({
        url: r.previewDataUrl,
        imageExtent: bounds,
        projection,
        // The preview is a decimated view of the raster, so let OL scale it up
        // rather than refuse to draw past its native size.
        imageSmoothing: true,
      }),
      opacity: r.opacity ?? 1,
    })
    // Which PNG this layer was built from. An ImageStatic's url is fixed at
    // construction, so a restyle (which swaps previewDataUrl on the same raster
    // record) can only reach the map by rebuilding the source — see sync().
    layer.set('previewUrl', r.previewDataUrl)
    // A computed ortho's brightness/contrast/gamma (the GPU path's style entries) as a
    // canvas filter around this layer's draw — the same maths (utils/orthoFilter.js).
    const filter = r.product ? orthoAdjustFilter(r.adjust) : null
    if (filter) {
      layer.on('prerender', (e) => {
        e.context.filter = filter
      })
      layer.on('postrender', (e) => {
        e.context.filter = 'none'
      })
    }
    layer.set('filter', filter)
    return layer
  }

  /**
   * A fresh, empty group for a new map. The stack sits above the basemap but below
   * the project's markers; a Group (rather than loose layers)
   * keeps that position fixed no matter when the async basemap resolves and
   * inserts itself at index 0.
   */
  function createGroup() {
    layers.clear()
    group = new LayerGroup({ layers: [] })
    return group
  }

  // Reconcile the group against `rasters()`. Diffed rather than rebuilt so that
  // dragging the opacity slider re-renders instead of tearing the image down and
  // reloading it on every input event. Takes no arguments (a watch callback).
  async function sync() {
    if (!ctx.map || !group) return
    const run = ++generation
    const want = [...(wanted() ?? [])]
    for (const r of want) {
      if (!r.vector && r.crs && r.crs !== modelCode()) await ensureProjection(r.crs).catch(() => {})
    }

    if (run !== generation || !ctx.map) return
    const seen = new Set()
    for (const r of want) {
      seen.add(r.id)
      const existing = layers.get(r.id)
      if (existing) {
        existing.setOpacity(r.opacity ?? 1)
        if (r.vector) {
          // The same features stay; new ones (a re-projection, a relink) are swapped in.
          if (existing.get('rev') !== r.rev) {
            existing.getSource().clear(true)
            existing.getSource().addFeatures(r.features().map(makeFootprintFeature))
            tagVector(existing, r)
          }
          continue
        }
        if (existing.get('gpuRaster')) {
          // A GPU layer restyles in place while it draws the same file; a rebuilt
          // product (new fileKey), or one that must now draw its preview, is rebuilt.
          if ((!r.product || r.cog) && existing.get('fileKey') === (r.fileKey ?? r.id)) {
            existing.setStyle(gpuRasterStyle(r))
            continue
          }
        } else if (
          existing.get('previewUrl') === r.previewDataUrl &&
          existing.get('filter') === (r.product ? orthoAdjustFilter(r.adjust) : null)
        ) {
          // Opacity is a live property; the image itself is not. A restyle (or a
          // kind flip) replaces previewDataUrl in place on the same record, so an
          // unchanged url is the ONLY case that may keep its source — otherwise the
          // layer would keep painting the pre-restyle PNG until the view is torn
          // down, which is exactly the "reload the view to see it" bug.
          continue
        }
        disposeRasterLayer(existing)
        layers.delete(r.id)
      }
      const layer = await makeRasterLayer(r)
      if (run !== generation || !ctx.map) {
        disposeRasterLayer(layer)
        return
      }
      if (layer) layers.set(r.id, layer)
    }
    for (const [id, layer] of [...layers]) {
      if (seen.has(id)) continue
      disposeRasterLayer(layer)
      layers.delete(id)
    }

    // Rewrite the collection in list order — the Layers panel's order IS the draw
    // order, so a layer moved in the list restacks on the map.
    const ordered = want.map((r) => layers.get(r.id)).filter(Boolean)
    group.getLayers().clear()
    for (const layer of ordered) group.getLayers().push(layer)
  }

  /**
   * Teardown with the map. Invalidates any sync still awaiting, and drops the
   * layers rather than leaving them attached to a detached group across a CRS
   * rebuild (the Static sources hold a decoded image each).
   */
  function dispose() {
    generation++
    for (const layer of layers.values()) disposeRasterLayer(layer)
    layers.clear()
    group = null
  }

  // Extents of the on-map layers in the VIEW projection. Each raster keeps its
  // native CRS (see makeRasterLayer), so its bounds are transformed here; one whose
  // CRS OL does not know is skipped rather than guessed. A vector layer is in the
  // view's CRS already.
  function extents() {
    const view = ctx.map?.getView().getProjection()
    const out = []
    for (const r of wanted() ?? []) {
      if (r.vector) {
        const e = layers.get(r.id)?.getSource().getExtent()
        if (e && Number.isFinite(e[0])) out.push(e)
        continue
      }
      const b = rasterBounds({ width: r.width, height: r.height, geoTransform: r.geoTransform })
      const proj = r.crs ? getOlProjection(r.crs) : null
      if (!b || !proj || !view) continue
      try {
        out.push(transformExtent(b, proj, view))
      } catch {
        /* unknown transform */
      }
    }
    return out
  }

  // Re-style the vector layers (the selected image changed).
  function restyle() {
    for (const layer of layers.values()) if (layer.get('vector')) layer.changed()
  }

  return { createGroup, sync, dispose, extents, restyle }
}
