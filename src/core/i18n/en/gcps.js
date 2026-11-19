// GCPs and markers in the views: the Points toolbox over a photo or the map
// (components/viewers/GcpToolbar.vue).
export default {
  toolbox: {
    title: 'Points',
    close: 'Exit point editing',
    // What a click does now. `name` is the selected point's.
    markImage: 'Click the photo to mark “{name}”',
    placeGround: 'Click the {where, select, raster {raster} other {map}} to place “{name}”',
    addImage: 'Click the photo to add a new {role, select, marker {marker} other {control point}}',
    addGround: 'Click the {where, select, raster {raster} other {map}} to add a new control point',
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
    placed: 'Has a ground position',
    unplaced: 'No ground position yet',
    disabled: '“{name}” is disabled: it is not used',
    delete: 'Delete this point',
    empty: 'No points yet. Click to add one.',
    markersHidden:
      '{n, plural, one {# marker is} other {# markers are}} not listed: a marker has no ground position. ' +
      'Mark {n, plural, one {it} other {them}} on a photo.',
  },
  // The Control & Markers table (components/controls/GcpTable.vue).
  table: {
    status: 'Status',
    statusTip: 'What the point still needs before it is used: X, Y and Z, an accuracy, and marks in two photos',
    datum: 'Height datum',
    datumTip:
      'What the Z values are measured from. RTK and GNSS receivers give ellipsoidal heights unless set to a ' +
      'geoid model; heights "above sea level" from a survey sheet or a national grid are Other geoid / national. ' +
      'It does not change the numbers or stop the point being used; it lets heights from different sources be ' +
      'converted (Convert heights to…).',
    accuracy: 'Accuracy',
    accuracyTip:
      'How well the coordinates are known, as σ in X/Y and Z: the method you measured them with. It sets X, Y and ' +
      'Z accuracy (type them for other values). Without one the point does not constrain the georeference.',
    summary: '{ready, number} of {control, plural, one {# control point} other {# control points}} can be used.',
    summaryFirst: '“{name}”: {needs}{more, plural, =0 {} other { (# more not ready)}}.',
    needThree: 'The georeference needs three.',
    estimateTip:
      'Greyed: where the georeferenced model puts this point, to help you find it. Type the surveyed value; ' +
      'until then the point is not used as control.',
    customTip: 'Shown when the accuracy was typed: type σ X/Y/Z to change it',
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
  // What a point still needs before it is used (core/gcpReadiness.js).
  need: {
    xy: 'no X/Y',
    z: 'no Z',
    accuracy: 'no accuracy (σ)',
    marks: 'marked in {n, number} of 2 photos',
  },
  status: {
    ready: { control: '✓ used', check: '✓ measured', marker: '✓ marked' },
    off: 'disabled',
  },
  datum: {
    unknown: 'Not set',
    ellipsoidal: 'Ellipsoidal (WGS 84)',
    geoidEGM2008: 'Geoid EGM2008',
    geoidEGM96: 'Geoid EGM96',
    orthometric: 'Other geoid / national',
    local: 'Local',
  },
  accuracy: {
    'unknown': 'Not set',
    'rtk-fixed': 'RTK fixed',
    'rtk-float': 'RTK float',
    'total-station': 'Total station',
    'map-picked': 'Picked off a map or orthophoto',
    'custom': 'Custom',
    'withValues': '{name} · {xy, number} / {z, number} m',
  },
  sidebar: {
    notReady: 'Not used yet: {needs}. Fill them in View ▸ Control & Markers.',
  },
}
