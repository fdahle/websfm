// What the 2D map plots, as plain data: which images / GCPs / footprints / poses
// get a marker, the hover text a marker shows, and the image it links to. Pure —
// components/viewers/ViewerMap.vue turns these into OpenLayers features.
//
// GCPs, footprints and poses are stored in the project CRS already (= the map
// view CRS), so none of them needs a transform. Each selector reads only its own
// inputs: ViewerMap's computeds call the one for the current frame, so a change
// to the other frame's data never re-runs them.

/** Images with EXIF GPS and no enabled imported pose (a pose supersedes the GPS). */
export function gpsImagesOf(images, poses) {
  return images.filter((img) => img.meta?.gpsLat != null && img.meta?.gpsLon != null
    && !poses.some((p) => p.imageId === img.id && p.enabled !== false))
}

// Copied to what a marker draws, so a computed over these also tracks name and
// role: the store renames / re-roles a GCP in place, which a bare filter (reading
// only enabled/x/y) misses.

/** Enabled GCPs with a valid position, as marker records. */
export function plottedGcps(gcps) {
  return gcps
    .filter((g) => g.enabled !== false && Number.isFinite(g.x) && Number.isFinite(g.y))
    .map((g) => ({ id: g.id, name: g.name, x: g.x, y: g.y, role: g.role }))
}

/** Markers triangulated into the model frame, as marker records. */
export function modelMarkerGcps(markers) {
  return markers.map((m) => ({ id: m.id, name: m.name, x: m.x, y: m.y, role: 'marker' }))
}

/**
 * Which points are plotted where: a rename or role change restyles the markers
 * but must not re-fit the view the way a moved/added/removed point does.
 */
export function gcpPlacement(list) {
  return list.map((g) => `${g.id}:${g.x}:${g.y}`).join('|')
}

/** Enabled footprints that have geometry. */
export function plottedFootprints(footprints) {
  return footprints.filter((f) => f.enabled !== false && f.rings?.length)
}

/** Enabled imported / EXIF poses with a valid position. */
export function plottedPoses(poses) {
  return poses.filter((p) => p.enabled !== false && Number.isFinite(p.x) && Number.isFinite(p.y))
}

/** The SfM camera centres in the model frame, as pose records. */
export function modelCameraPoses(cameras) {
  return cameras.map((c) => ({ x: c.x, y: c.y, imageId: c.imageId, imageName: c.imageName, source: 'sfm' }))
}

/** True once a sparse model exists but this image's uuid wasn't registered into it. */
export function isUnaligned(uuid, hasSparse, alignedUuids) {
  return hasSparse && uuid != null && !alignedUuids.has(uuid)
}

/**
 * Hover label for a map feature (anything with `get(key)`): GCP / marker,
 * footprint, camera, else the image GPS marker's name. `unaligned` marks the
 * last case as not registered into the sparse model.
 */
export function hoverText(feature, unaligned) {
  const gcpName = feature.get('gcpName')
  const fpName = feature.get('footprintName')
  const poseName = feature.get('poseName')
  const imgName = feature.get('name')
  return gcpName ? `${feature.get('gcpRole') === 'marker' ? 'Marker' : 'GCP'}: ${gcpName}`
    : fpName ? `Footprint: ${fpName}`
    : poseName ? `Camera: ${poseName}`
    : unaligned ? `${imgName} (not aligned)` : imgName
}

/**
 * The loaded image a footprint / pose / GPS marker links to. An imported
 * footprint's imageId may name an image that is not (or no longer) in the
 * project, so only a link that resolves counts.
 */
export function linkedImageOf(feature, images) {
  const imgId = feature.get('imgId')
  return imgId ? images.find((i) => i.id === imgId) ?? null : null
}
