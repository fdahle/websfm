// File names of the exports. Each export has a default name (no extension) built from
// the project's name, or a cloud's, and what it is; the export dialogs show it in their
// optional File name field, and a name typed there replaces it for every file the
// export writes: a world file and .prj beside an image take the same name, and an
// export of several rasters (slope, hillshade) adds each one's suffix to it.

// A name as a file name: letters (any script), digits, `_ . -`; the rest becomes `_`.
// A trailing extension is dropped, so "south.laz" or a typed "site.tif" does not read
// as the export's own format.
export function fileSafe(name) {
  return String(name ?? '')
    .trim()
    .replace(/[^\p{L}\p{N}_.-]+/gu, '_')
    .replace(/^_+|_+$/g, '')
    .replace(/\.[a-z0-9]{2,4}$/i, '')
    .slice(0, 80)
}

// The typed name when there is one, else the default.
export function exportFileName(typed, fallback) {
  return fileSafe(typed) || fallback
}

// The default name of an export of `kind` in `format`. `base` is the project's name,
// or for a cloud or mesh the name its own export uses (exports/clouds.js). `crs` is the
// CRS of a reprojected DEM / orthophoto (null when written as built); `product` the
// raster a clip is cut from ('dem' | 'ortho').
export function defaultExportName(kind, { format = null, base, crs = null, product = null } = {}) {
  const tag = crs ? String(crs).replace(/[^A-Za-z0-9]+/g, '') : ''
  switch (kind) {
    case 'cloud':
    case 'mesh':
      return base
    case 'model':
      return `${base}-${format === 'transforms' ? 'transforms' : 'model'}`
    case 'colmap':
      if (format === 'nvm') return base
      if (format === 'openmvg') return `${base}-sfm_data`
      if (format === 'transforms') return `${base}-transforms`
      if (format === 'database') return `${base}-database`
      if (format === 'workspace') return `${base}-colmap-workspace`
      return `${base}-colmap-${format === 'bin' ? 'bin' : 'txt'}`
    case 'tiles3d':
      return `${base}-3dtiles`
    case 'undistorted':
      return `${base}-undistorted`
    case 'dem':
    case 'ortho':
      if (tag) return `${base}-${kind}-${tag}`
      if (format === 'cog') return `${base}-${kind}-cog`
      if (kind === 'dem' && format === 'png') return `${base}-dem-hillshade`
      if (kind === 'dem' && format === 'support') return `${base}-dem-support`
      return `${base}-${kind}`
    case 'measurements':
      return `${base}-measurements`
    case 'contours':
      return `${base}-contours`
    // Each terrain raster adds its own suffix (-slope, -aspect, -hillshade).
    case 'terrain':
      return `${base}-dem`
    case 'clip':
      return `${base}-${product === 'ortho' ? 'ortho' : 'dem'}-clipped`
    case 'section':
      return `${base}-section`
    default:
      return base
  }
}
