// GCPs and markers in the views: the Points toolbox over a photo or the map
// (components/viewers/GcpToolbar.vue).
export default {
  toolbox: {
    title: 'Points',
    close: 'Exit point editing',
    // What a click does now. `name` is the selected point's.
    markImage: 'Click the photo to mark “{name}”',
    placeMap: 'Click the map to place “{name}”',
    addImage: 'Click the photo to add a new {role, select, marker {marker} other {control point}}',
    addMap: 'Click the map to add a new control point',
    newControl: '＋ New control',
    newControlTip: 'A surveyed point that constrains georeferencing',
    newMarker: '＋ New marker',
    newMarkerTip: 'A scale-bar endpoint: image marks, no surveyed position',
    // Group headers of the list, by role.
    group: {
      control: 'Control ({n, number})',
      check: 'Checkpoints ({n, number})',
      marker: 'Markers ({n, number})',
    },
    markedImage: 'Marked on this photo',
    unmarkedImage: 'Not marked on this photo',
    placedMap: 'Placed on the map',
    unplacedMap: 'No ground position yet',
    disabled: '“{name}” is disabled: it is not used',
    delete: 'Delete this point',
    empty: 'No points yet. Click to add one.',
    markersHidden:
      '{n, plural, one {# marker is} other {# markers are}} not listed: a marker has no ground position. ' +
      'Mark {n, plural, one {it} other {them}} on a photo.',
  },
  // The Control & Markers table (components/controls/GcpTable.vue).
  table: {
    estimateTip:
      'Greyed: where the georeferenced model puts this point, to help you find it. Type the surveyed value; ' +
      'until then the point is not used as control.',
  },
  // The GCP view (components/viewers/ViewerGcp.vue): a square per photo around the mark.
  view: {
    fallbackName: 'GCP',
    coords: 'X {x} · Y {y}',
    coordsZ: 'X {x} · Y {y} · Z {z}',
    noCoords: 'no coordinates',
    estimate: 'the model puts it at ≈ X {x} · Y {y} · Z {z}',
    photos: '{n, plural, one {# photo} other {# photos}}',
    notLoaded: '+{n, number} not loaded',
    notLoadedTip: '{n, plural, one {# mark is} other {# marks are}} on photos that are not in the project (yet)',
    acceptAll: 'Accept {n, plural, one {# detection} other {# detections}}',
    acceptAllTip: 'Keep every mark Detect targets placed here as yours; remove the bad ones first ({key})',
    zoomIn: 'Zoom in',
    zoomOut: 'Zoom out',
    open: 'Open {name}',
    detected: 'detected {score, number, ::.00}',
    detectedTip: 'Placed by Detect targets (score); drag it if it is off, then it counts as yours',
    reproj: '{px, number, ::.0} px',
    reprojTip: 'Reprojection error',
    accept: 'Accept the detected mark in {name}: it counts as yours ({key} on the highlighted one)',
    remove: 'Remove the mark in {name}',
    removeKey: 'Remove the mark in {name} ({key} on the highlighted one)',
    dragTip: 'Drag to move the mark',
    empty: 'This GCP has no marks on the photos yet. Mark it in a photo (Edit GCPs, or right-click a photo).',
    // The likely places: photos with no mark of this GCP, where the model puts it.
    likely: 'Likely in {n, plural, one {# more photo} other {# more photos}}',
    fromMarks: 'from its {n, plural, one {# mark} other {# marks}}',
    fromMarksRejected: 'from {used, number} of its {n, number} marks; {rejected, number} disagree with the rest',
    fromCoordinates: 'from its coordinates through the georeference',
    likelyHint: 'Click where the point is, or drag the crosshair onto it, to mark it there.',
    likelyNone:
      '{why, select, oneMark {Mark it in one more photo, and the photos it is likely in show here.} noModel {Run Sparse Model, and the photos it is likely in show here.} other {}}',
    likelyTip: 'Where the model puts the point in {name}. Click it where the point is, or drag the crosshair',
    place: 'Mark it here: at the crosshair ({key} on the highlighted one)',
    dismiss: 'Not in this photo: hide it ({key} on the highlighted one)',
    showMore: 'Show {n, plural, one {# more} other {# more}}',
  },
}
