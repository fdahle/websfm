// Import ▸ Camera Parameters (components/modals/import/CameraImportModal.vue): camera
// positions and orientations, or calibrations, from a delimited text file.
export default {
  title: 'Import Camera Parameters',
  delimiter: 'Delimiter',
  header: 'First row is a header',
  focalUnit: 'Focal length in',
  unit: { mm: 'mm', px: 'pixels' },
  sourceCrs: 'Source CRS of these positions',
  datum: 'Height datum',
  datumTip:
    'What the heights are measured from. RTK and GNSS receivers give ellipsoidal heights unless set to a geoid ' +
    'model. With GCPs in another datum, a declared datum lets Sparse Model convert the heights exactly ' +
    'instead of estimating the offset between the two.',
  mapping: 'Column mapping',
  poseNote:
    'Accuracies are 1σ values. Position accuracies constrain reconstruction; orientation accuracies constrain ' +
    'omega, phi and kappa.',
  ignore: 'Ignore',
  // A position column, named by the source CRS's axis (E, N, Lon, Lat, h …).
  abs: 'Abs {axis}',
  targets: 'Where it goes',
  targetFor: 'Target for imported sensor {n, number}',
  newSensor: 'New sensor',
  updateSensor: 'Update {name} ({n, plural, one {# image} other {# images}})',
  // An imported sensor's name: its label in the file, else the images it covers.
  sensorImages: '{first} +{n, number} more',
  sensorAt: 'Sensor {n, number} in file',
  sensorOnly: 'Sensor in file',
  // What an imported sensor carries, joined with " · ".
  part: {
    focal: 'f {f} {unit}',
    size: '{w}×{h} px',
    pixel: 'pixel {size} mm',
    principal: 'principal point',
    lens: 'lens {model}',
    distortion: 'distortion',
    marks: '{n, plural, one {# fiducial mark} other {# fiducial marks}}',
  },
  outcomeNew:
    '{n, plural, =0 {New sensor, no images assigned yet} one {New sensor, # image assigned} other {New sensor, # images assigned}}',
  outcomeUpdate:
    'Updates {name}{why, select, label { (same label)} images { (the sensor of exactly these images)} sole { (the project’s only sensor)} other {}}' +
    '{n, plural, =0 {} one {, # image assigned} other {, # images assigned}}',
  unmatched: '· {n, plural, one {# image name} other {# image names}} not in the project',
  emptied:
    '{names} will have no images left; remove {n, plural, one {it} other {them}} in the sensor table if no longer needed.',
  sensors: '{n, plural, one {# sensor} other {# sensors}}',
  poses: '{n, plural, one {# pose} other {# poses}}',
  skipped: ' · {n, plural, one {# row} other {# rows}} skipped',
  needIntrinsic: 'Assign at least one intrinsic column (focal, dimensions…).',
  needImage: 'Assign an <strong>Image name</strong> column.',
  needXY: 'Assign <strong>Abs {x}</strong> and <strong>Abs {y}</strong> columns.',
  // Why Import is greyed (its tooltip).
  reason: {
    noSensors: 'No camera calibrations found in the file',
    noImage: 'Choose the column with the image names',
    noXY: 'Choose the X and Y columns',
    noRows: 'No rows with a position were found',
  },
  importCalibration: 'Import calibration',
  importPoses: 'Import poses',
}
