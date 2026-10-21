// Marker styles of the 2D map. The Style objects are shared module constants
// (OL styles are immutable in use); the style functions pick one per feature from
// the state ViewerMap passes in (selection, alignment), so they hold no state.
// The legend's CSS swatches in ViewerMap.vue mirror these colours.

import { Style, Circle as CircleStyle, RegularShape, Fill, Stroke } from 'ol/style'

// ── Image GPS markers: blue circles ──────────────────────────────────────────

const normalStyle = new Style({
  image: new CircleStyle({
    radius: 6,
    fill: new Fill({ color: '#0e639c' }),
    stroke: new Stroke({ color: '#fff', width: 1.5 }),
  }),
})

const selectedStyle = new Style({
  image: new CircleStyle({
    radius: 8,
    fill: new Fill({ color: '#f0a500' }),
    stroke: new Stroke({ color: '#fff', width: 2 }),
  }),
})

// Faded marker for an image that failed to register into the sparse model.
const unalignedStyle = new Style({
  image: new CircleStyle({
    radius: 6,
    fill: new Fill({ color: 'rgba(120, 130, 140, 0.5)' }),
    stroke: new Stroke({ color: 'rgba(255, 255, 255, 0.6)', width: 1.5 }),
  }),
})

/** `unaligned`: (feature) => boolean, asked only for an unselected marker. */
export function imageStyle(feature, selectedId, unaligned) {
  if (feature.get('imgId') === selectedId) return selectedStyle
  return unaligned(feature) ? unalignedStyle : normalStyle
}

// ── GCP markers: diamonds, visually distinct from the image-GPS circles ──────

const controlStyle = new Style({
  image: new RegularShape({
    points: 4,
    radius: 7,
    angle: Math.PI / 4,
    fill: new Fill({ color: '#3fae6a' }),
    stroke: new Stroke({ color: '#fff', width: 1.5 }),
  }),
})

const checkStyle = new Style({
  image: new RegularShape({
    points: 4,
    radius: 7,
    angle: Math.PI / 4,
    fill: new Fill({ color: '#38a9c7' }),
    stroke: new Stroke({ color: '#fff', width: 1.5 }),
  }),
})

// A marker has no surveyed position; on the model map it sits where its marks
// triangulate.
const markerStyle = new Style({
  image: new RegularShape({
    points: 4,
    radius: 7,
    angle: Math.PI / 4,
    fill: new Fill({ color: '#e0a030' }),
    stroke: new Stroke({ color: '#fff', width: 1.5 }),
  }),
})

export function gcpStyle(feature) {
  const role = feature.get('gcpRole')
  return role === 'check' ? checkStyle : role === 'marker' ? markerStyle : controlStyle
}

// ── Camera-position markers: triangles, distinct from circles and diamonds ───

const poseStyleImported = new Style({
  image: new RegularShape({
    points: 3,
    radius: 7,
    fill: new Fill({ color: '#b06ad9' }),
    stroke: new Stroke({ color: '#fff', width: 1.5 }),
  }),
})

const exifPoseStyle = new Style({
  image: new RegularShape({
    points: 3,
    radius: 7,
    fill: new Fill({ color: '#297fb8' }),
    stroke: new Stroke({ color: '#fff', width: 1.5 }),
  }),
})

const poseSelectedStyle = new Style({
  image: new RegularShape({
    points: 3,
    radius: 9,
    fill: new Fill({ color: '#f0a500' }),
    stroke: new Stroke({ color: '#fff', width: 2 }),
  }),
})

export function poseStyle(feature, selectedId) {
  if (feature.get('imgId') === selectedId) return poseSelectedStyle
  return feature.get('poseSource') === 'exif' ? exifPoseStyle : poseStyleImported
}

// ── Footprint polygons: translucent; brighter when the linked image is selected ─

const footprintNormalStyle = new Style({
  fill: new Fill({ color: 'rgba(14, 99, 156, 0.12)' }),
  stroke: new Stroke({ color: 'rgba(14, 99, 156, 0.8)', width: 1.5 }),
})

const footprintSelectedStyle = new Style({
  fill: new Fill({ color: 'rgba(240, 165, 0, 0.22)' }),
  stroke: new Stroke({ color: '#f0a500', width: 2.5 }),
})

export function footprintStyle(feature, selectedId) {
  return feature.get('imgId') && feature.get('imgId') === selectedId ? footprintSelectedStyle : footprintNormalStyle
}
