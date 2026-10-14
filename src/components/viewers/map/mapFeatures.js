// OpenLayers features for the 2D map's markers, one factory per kind. The
// properties set here are what the map's hit-testing reads back: `imgId` (select /
// open image), `gcpId` (select / drag a GCP), and the name properties the hover
// label shows (core/mapData.js hoverText). Inputs are the records core/mapData.js
// selects; GCPs, footprints and poses are already in the view CRS.

import Feature from 'ol/Feature'
import Point from 'ol/geom/Point'
import Polygon from 'ol/geom/Polygon'
import { transform } from '../../../core/crs.js'

/** Image GPS is always WGS84 (from EXIF); project it into the view CRS. */
export function projectLonLat(lon, lat, crs) {
  return transform([lon, lat], 'EPSG:4326', crs)
}

export function makeImageFeature({ id, uuid, name, meta }, crs) {
  const f = new Feature({ geometry: new Point(projectLonLat(meta.gpsLon, meta.gpsLat, crs)) })
  f.set('imgId', id)
  f.set('uuid', uuid)
  f.set('name', name)
  return f
}

export function makeGcpFeature(g) {
  const f = new Feature({ geometry: new Point([g.x, g.y]) })
  f.set('gcpName', g.name)
  f.set('gcpId', g.id)
  f.set('gcpRole', g.role ?? 'control')
  return f
}

export function makeFootprintFeature(fp) {
  const f = new Feature({ geometry: new Polygon(fp.rings) })
  // Hover label: the image the polygon belongs to, else the layer name.
  f.set('footprintName', fp.imageName ?? fp.setName ?? fp.name)
  if (fp.imageId) f.set('imgId', fp.imageId)
  return f
}

export function makePoseFeature(p) {
  const f = new Feature({ geometry: new Point([p.x, p.y]) })
  f.set('poseName', p.imageName)
  if (p.imageId) f.set('imgId', p.imageId)
  f.set('poseSource', p.source ?? 'imported')
  return f
}
