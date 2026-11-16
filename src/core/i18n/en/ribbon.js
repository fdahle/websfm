// The ribbon. Its commands, menus, groups, tabs and prerequisite reasons are worded in
// their tables (core/help/ribbonTabs.js, commands.js) and taken in from there
// (core/help/ribbonText.js); `ui` holds the ribbon's own words around them.
import { ribbonCatalogue } from '../../help/ribbonText.js'

export default {
  ...ribbonCatalogue().catalogue,
  ui: {
    project: 'Project',
    image: 'Image',
    new: 'new',
    smaller: 'Smaller {what}',
    larger: 'Larger {what}',
    smallest: 'Already the smallest',
    largest: 'Already the largest',
    needsDemNotOrtho: 'Needs a DEM — this is an orthophoto',
    needsDemOnMap: 'Needs a DEM on the map',
    measureNeedsFrame:
      'Measuring needs a current frame with linear coordinates (not geographic, not an outdated frame)',
    needsDemHeights: 'Needs the DEM elevation values, which are not loaded yet',
    noSavedMeasurements: 'No saved measurements on this raster yet',
    nothingToStyle: 'Nothing to style — an 8-bit raster with up to 3 bands is shown as it is',
    detectKeypointsFirst: 'Detect keypoints first',
    noMask: 'No mask available',
    noDepth: 'No depth map available',
    noGcps: 'No GCPs on this image',
  },
}
