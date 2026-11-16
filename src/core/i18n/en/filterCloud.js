// Filter Cloud (components/modals/cloud/FilterCloudModal.vue) and its step effects
// (core/stepEffects/filterCloud.js).
export default {
  title: {
    filter: 'Filter Cloud',
    sor: 'Remove Outliers',
    voxel: 'Subsample Cloud',
  },
  noCloud:
    'No dense cloud is available. Build one first (<strong>Reconstruct ▸ Dense Model</strong>), or import one. ' +
    'To clean the sparse model, use <strong>Tools ▸ Model ▾ ▸ Gradual selection…</strong>.',
  sourceHint: 'The filter adds a new cloud; this one is left untouched.',
  run: 'Filter',
  // The new cloud's name.
  resultName: '{name} (filtered)',
  disabled: {
    noCloud: 'No dense cloud yet: build one with Reconstruct ▸ Dense Model, or import one',
    noFilter: 'Turn on at least one filter',
  },
  preset: {
    light: { label: 'Light', blurb: 'Outlier removal only · trims obvious flyers' },
    medium: { label: 'Balanced', blurb: 'Outlier removal at 1.5σ · default' },
    strong: { label: 'Strong', blurb: 'Isolated clusters + 1.0σ · may bite into thin detail' },
  },
  step: {
    range: 'Elevation / brightness range',
    voxel: 'Voxel downsample',
    isolated: 'Isolated clusters',
    sor: 'Statistical outliers',
  },
  field: {
    zRange: { label: 'Elevation (Z)', hint: 'Leave empty for unbounded.' },
    lumaRange: { label: 'Brightness', hint: 'Rec. 709 luma. Ignored on a cloud with no colour.' },
    voxelCell: {
      label: 'Cell size',
      hintMerge: "0 = auto (the dense run's merge cell, {cell, number, ::@##})",
      hintAuto: '0 = auto (about one point spacing)',
    },
    isolatedCell: { label: 'Cell size', hint: 'Occupancy grid cell. 0 = auto (about 4× the point spacing).' },
    isolatedMinNeighbors: {
      label: 'Min occupied neighbours',
      hint: 'A low-support cell needs this many of its 26 neighbours occupied to survive.',
    },
    isolatedMaxSupport: {
      label: 'Max tested support',
      unit: 'points',
      hint: 'Cells holding more points than this are never tested — they are real surface.',
    },
    sorK: { label: 'Neighbours', hint: 'How many nearest neighbours the per-point mean distance averages over.' },
    sorStdRatio: { label: 'Std-dev ratio', hint: 'Drop points above mean + ratio × σ. Lower is more aggressive.' },
  },

  // A bound the user typed, digits as typed.
  span: {
    between: '{lo, number, ::.##########} – {hi, number, ::.##########}',
    atLeast: 'at least {lo, number, ::.##########}',
    atMost: 'at most {hi, number, ::.##########}',
  },
  effect: {
    range: {
      off: 'Off: no elevation or brightness limit.',
      none: 'No limit entered yet: every point passes. Set an elevation or brightness bound.',
      // {limits}: a list of the two below.
      kept: 'Points are kept with {limits}; the rest are removed.',
      elevation: 'elevation {span}',
      brightness: 'brightness {span}',
    },
    voxel: {
      off: 'Off: the point density is left as it is.',
      cell: 'The cloud is thinned to one averaged point per cell of {cell}.',
      mergeCell: 'The cloud is thinned to one averaged point per cell of {cell}, the dense run’s merge cell.',
      spacing: 'The cloud is thinned to one averaged point per cell of about one point spacing.',
    },
    isolated: {
      off: 'Off: small detached clusters stay.',
      on:
        'On a grid of {cell}, cells holding at most {maxSupport, plural, one {# point} other {# points}} ' +
        'with fewer than {minNeighbors, number} occupied neighbours are removed.',
      autoCell: 'about 4 point spacings',
    },
    sor: {
      off: 'Off: no statistical outlier test.',
      on:
        'A point is removed when its mean distance to its {k, number} nearest neighbours is more than ' +
        '{ratio, number} σ above the cloud’s mean.',
    },
  },
  // The steps' short facts (≤ SHORT_MAX characters in every language).
  short: {
    range: {
      none: 'no limit yet',
      z: 'z {span}',
      zAndBrightness: 'z {span} · brightness',
      brightness: 'brightness',
    },
    voxel: { cell: '{cell} cells', spacing: 'one point spacing' },
    // A "<" before a letter would open a tag; before a space it is a plain "<".
    isolated: '≤ {maxSupport, number} pts, < {minNeighbors, number} neighbours',
    sor: '{k, number} neighbours · {ratio, number} σ',
  },
}
