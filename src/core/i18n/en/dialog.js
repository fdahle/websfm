// The parts many dialogs share (components/modals/ui/): raster size, output step,
// Presets ▾, coordinate frame, CRS suggestion, Import as, file name, "nothing to act on".
// {kind} selects a product: dem, ortho, mesh, dense.
export default {
  noSource: {
    cloud: 'No dense cloud yet. Build one with <strong>Reconstruct ▸ Dense Model</strong> or import one.',
    mesh: 'No mesh yet. Build one with <strong>Reconstruct ▸ Mesh</strong> or import one.',
  },

  rasterSize: {
    sizeBy: {
      label: 'Raster size by',
      hint: 'Set the cell size, or the pixels on the longer side and let the cell size follow from the extent.',
      gsd: 'Cell size (GSD)',
      px: 'Long side (px)',
    },
    gsd: { label: 'Ground sample distance' },
    longSide: { label: 'Long side', hint: 'Pixels on the longer side of the raster. 0 = auto.' },
    estimating: 'Estimating the size…',
    unavailable: 'Raster size: {reason}.',
    // {gsd}: a cell size as below; {bytes}: "50 MB".
    readout:
      '{approx, select, yes {≈ } other {}}{width, number} × {height, number} px at {gsd} {unit} · {bytes} uncompressed',
    // Three significant digits under 100 (0.0310), whole numbers above.
    cell: '{whole, select, yes {{g, number, ::precision-integer}} other {{g, number, ::@@@}}}',
    capped:
      'A raster is at most {max, number} px a side, so the run uses {gsd} instead of {requested} {unit}. ' +
      'Limit the area (Tools ▸ Model ▸ Region) for a finer cell.',
  },

  output: {
    title: 'Output',
    label: 'Replace the main {kind, select, dem {DEM} ortho {orthophoto} mesh {mesh} other {dense cloud}}',
    hint:
      'Off: older {kind, select, dem {DEMs} ortho {orthophotos} mesh {meshes} other {dense clouds}} stay, and the ' +
      "new one becomes the main one (the input of the next step). On: the new one takes the main one's place and name.",
    // The step's effect (core/stepEffects/output.js).
    effect: {
      first: 'The first {kind, select, dem {DEM} ortho {orthophoto} mesh {mesh} other {dense cloud}}: "{name}"',
      replaces: 'Replaces "{main}"; products built on it are kept, marked outdated',
      kept:
        '"{main}" is not one the pipeline built, so it stays: adds "{name}" as the main ' +
        '{kind, select, dem {DEM} ortho {orthophoto} mesh {mesh} other {dense cloud}}',
      adds: 'Adds "{name}" as the main {kind, select, dem {DEM} ortho {orthophoto} mesh {mesh} other {dense cloud}}; "{main}" stays',
    },
    short: { first: 'first', replaces: 'replaces "{main}"', adds: 'adds "{name}"' },
  },

  presets: {
    button: 'Presets ▾',
    buttonLast: 'Presets · last run ▾',
    buttonNamed: 'Presets · {name} ▾',
    titleLast: 'Opened on the settings of the last run in this project',
    titleNamed: 'Preset {name}',
    title: 'Save these settings, or bring back a saved set',
    delete: 'Delete {name}',
    none: 'No saved presets for this dialog yet.',
    namePlaceholder: 'Name these settings',
    save: 'Save',
    typeName: 'Type a name first',
    reset: 'Reset to defaults',
  },

  frame: {
    label: 'Coordinate frame',
    hintScaled:
      'Local uses a camera-estimated orientation and the current highest-ranked scale evidence, so coordinates are ' +
      'metric but have no CRS.',
    hint:
      'Local uses a camera-estimated up-vector (up-to-scale); the project CRS fits a similarity to imported poses ' +
      'for real-world {what, select, heights {heights} other {coordinates}} & GSD.',
    localScaled: 'Local (metres, no CRS)',
    local: 'Local (model units)',
    project: 'Project CRS',
    // After the project CRS's name in the option, and as its tooltip.
    blocked: {
      geographic: ' — geographic CRS',
      evidence: ' — needs ≥3 camera positions or GCPs',
    },
    blockedTitle: {
      geographic: 'The project CRS is geographic (degrees): choose a projected CRS to get metres',
      evidence: 'Georeferencing needs at least three camera positions or GCPs',
      other: 'The model is not georeferenced yet',
    },
  },

  crs: {
    inDegrees: '{crs} is in degrees, so the model cannot be fitted to it.',
    chooseProjected: 'Choose a projected CRS in Project Settings.',
    productsNeedProjected: 'DEMs and orthophotos can only be georeferenced in a projected CRS.',
    use: 'Use {code} · {name}',
    from:
      'From {count, plural, one {# camera position} other {# camera positions}} around {where}. Changing the CRS ' +
      'reprojects existing positions and GCPs.',
  },

  importKind: {
    label: 'Import as',
    gcp: 'Ground Control Points',
    pose: 'Camera Positions',
    sensor: 'Camera Intrinsics',
    // <first> and <second>: the two other kinds, drawn as links. A tag and a parameter
    // never share a name: both go to the formatter in one object (i18n.test.js).
    declared:
      'Importing as <strong>{kind}</strong>. Not right? Import as <first>{firstKind}</first> or <second>{secondKind}</second>.',
  },

  fileName: {
    label: 'File name',
    savedAs: 'Saved as {name}; the extension is added.',
    hint: 'Optional. The extension is added; a world file or .prj beside it takes the same name.',
  },
}
