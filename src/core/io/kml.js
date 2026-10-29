// A polygon or line layer (useFootprintsStore set) → KML, for Google Earth and other
// globe viewers. KML is longitude/latitude on WGS 84 only, so the caller passes
// `toLonLat` ([x, y] in the project CRS → [lon, lat]). Polygons are named by their
// image, as the GeoJSON export names them; a contour line carries its elevation. Both
// lie on the ground (KML's default altitude mode): footprints have no height.

const esc = (s) =>
  String(s ?? '').replace(
    /[<>&'"]/g,
    (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', "'": '&apos;', '"': '&quot;' })[c],
  )

export function vectorSetToKml(set, { toLonLat }) {
  const coords = (path) =>
    path
      .map((c) => toLonLat([c[0], c[1]]))
      .map(([lon, lat]) => `${lon},${lat}`)
      .join(' ')
  const ring = (r) => {
    const [a, b] = [r[0], r[r.length - 1]]
    const closed = a && b && (a[0] !== b[0] || a[1] !== b[1]) ? [...r, a] : r
    return `<LinearRing><coordinates>${coords(closed)}</coordinates></LinearRing>`
  }
  const placemarks = []
  for (const fp of set?.footprints ?? []) {
    if (fp.rings?.length) {
      const [outer, ...holes] = fp.rings
      placemarks.push(
        `<Placemark><name>${esc(fp.imageName ?? fp.name)}</name><Polygon>` +
          `<outerBoundaryIs>${ring(outer)}</outerBoundaryIs>` +
          holes.map((h) => `<innerBoundaryIs>${ring(h)}</innerBoundaryIs>`).join('') +
          `</Polygon></Placemark>`,
      )
    }
    for (const path of fp.lines ?? []) {
      const name = fp.level != null ? `<name>${esc(fp.level)}</name>` : ''
      placemarks.push(
        `<Placemark>${name}<LineString><coordinates>${coords(path)}</coordinates></LineString></Placemark>`,
      )
    }
  }
  return (
    '<?xml version="1.0" encoding="UTF-8"?>\n' +
    '<kml xmlns="http://www.opengis.net/kml/2.2"><Document>' +
    `<name>${esc(set?.name)}</name>\n` +
    placemarks.join('\n') +
    '\n</Document></kml>\n'
  )
}
