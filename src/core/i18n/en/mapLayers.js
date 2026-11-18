// View ▸ Map ▸ Layers (components/viewers/map/MapLayersPanel.vue): the layers on the 2D
// map, top first, and the selected layer's settings.
export default {
  title: 'Layers',
  close: 'Close the layers panel',
  empty:
    'No layers on the map. Tick a DEM, orthophoto, reference raster, contour or polygon layer in the sidebar to add ' +
    'it here.',
  list: 'Map layers, top first',
  // What a row is, under its name.
  kind: {
    referenceDem: 'Reference DEM',
    referenceOrtho: 'Reference orthophoto',
    dem: 'DEM',
    ortho: 'Orthophoto',
    contours: 'Contour lines',
    polygons: 'Polygons',
    photos: 'Source images on the ground',
  },
  // The Photos layer's name in the list.
  photos: 'Photos',
  unplaced: 'No coordinate system or preview: the map cannot place it',
  row: '{kind} · click for its settings',
  drag: 'Drag to restack: the top of the list draws on top',
  show: { label: 'Show {name} on the map', title: 'Shown on the map; unticked, it stays in the list' },
  up: { label: 'Move {name} up', title: 'Up: draw above the layer over it' },
  down: { label: 'Move {name} down', title: 'Down: draw below the layer under it' },
  remove: { label: 'Remove {name} from the map', title: 'Remove from the map (it stays in the sidebar)' },
  settingsOf: 'Settings of {name}',
  opacity: { label: 'Opacity of {name}', title: 'Opacity on the map', value: '{v, number, percent}' },
  zoomTo: { label: 'Zoom to', title: 'Fit the map to this layer', hidden: 'Tick it to show it first' },
  photosShow: {
    label: 'Show',
    all: 'Every image (thumbnails)',
    selected: 'The selected image',
    hint: 'Click a camera or footprint (or an image in the sidebar) to show its photo.',
  },
  above: 'Footprints, GCPs and cameras always draw above the layers.',
}
