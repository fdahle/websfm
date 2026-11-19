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
}
