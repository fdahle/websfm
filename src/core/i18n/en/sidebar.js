// The sidebar's sections (layout/sidebar/). ICU MessageFormat, as in common.js.
export default {
  images: {
    // Images ▸ Group by: list the images under their image groups or their sensors.
    groupBy: 'Group by',
    byGroup: 'Groups',
    bySensor: 'Sensors',
    byGroupTitle: 'List the images under the image groups you made',
    bySensorTitle: 'List the images under their sensors. Drag images onto a sensor to move them there',
    noSensor: 'No sensor',
    noSensorTitle: 'Images not bound to a sensor yet',
    sensorHeader: '{name} — {n, plural, one {# image} other {# images}}. Drop images here to move them to this sensor',
    // The image menu.
    setSensor: 'Set sensor',
    newSensor: '{n, plural, one {New sensor for this image} other {New sensor from selection}}',
    newSensorTitle: 'Give these images a sensor of their own, a copy of the one they use now',
    // The menu of a sensor's header in Group by ▸ Sensors.
    sensorInfo: 'Show sensor information',
  },
  sensors: {
    title: 'Sensors',
    collapse: 'Collapse',
    expand: 'Expand',
    incomplete:
      'No usable calibration — intrinsics fall back to a default field-of-view guess, which distorts SfM and depth maps. Set a focal length in the sensor table.',
    // A group that may hold photos of more than one camera (core/sensors/splitSuggestions.js).
    split: 'May hold photos of {n} cameras ({why}). Right-click the sensor and choose Split camera group…',
    splitFormats: '{n} scan formats',
    splitMisfit: '{roll} fits the fiducial layout badly',
    count: '{n, plural, one {# image} other {# images}}: click to select them in Images',
    countNone: 'No images use this sensor',
    source: 'Source',
    sourceExif: 'EXIF',
    sourceImported: 'imported',
    dimensions: 'Dimensions',
    dimensionsValue: '{w, number} × {h, number}',
    focal: 'Focal',
    focalValue: '{v, number, ::@##} {unit}',
    principal: 'Principal pt',
    principalValue: '{x, number, ::.#}, {y, number, ::.#}',
    lens: 'Lens',
    none: '—',
    empty: 'No sensors — add images or import a calibration',
    menu: {
      info: 'Show information',
      selectImages: 'Select images',
      split: 'Split camera group…',
      mergeInto: 'Merge into',
      remove: 'Remove sensor',
    },
  },
}
