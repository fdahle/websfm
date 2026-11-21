// The Quality Report (components/modals/eval/): its sections' labels. Numbers come in
// as parameters, so they get the language's decimal sign.
export default {
  // A value with one or two decimals.
  decimal1: '{v, number, ::.0}',
  decimal2: '{v, number, ::.00}',
  // When a value is flagged (core/eval/health.js thresholdHintMsg).
  threshold: {
    above: 'warn > {warn, number} {unit}',
    aboveAbs: 'warn > ±{warn, number} {unit}',
    below: 'warn < {warn, number} {unit}',
  },
  // Quality Report ▸ Calibration (EvalCalibrationSection.vue).
  calibration: {
    noSensors: 'No reconstructed sensors.',
    selfCalOff:
      'Self-calibration was off for this run: no solved lens to report. The focal comparison below still applies.',
    notRecorded:
      'This model was saved before WebSfM kept each model’s own lens, so the lens shown is the last Sparse Model ' +
      'run’s. Run Sparse Model again for this model’s own.',
    cameras: '{n, plural, one {# camera} other {# cameras}}',
    refinedFx: 'Refined fx',
    nominalFx: 'Nominal fx',
    focalDelta: 'Δ focal',
    fxValue: '{v, number, ::.0}',
    fxSigma: '{v, number, ::.0} ± {s, number, ::.0}',
    deltaPx: '{v, number, ::.0} px',
    deltaPct: '({v, number, ::sign-always .0} %)',
    // The focal's σ (bundle.rs ▸ lens σ; core/sfm/focalSigma.js).
    focalUnfixed:
      'These photos do not fix the focal (± {pct, number} %), and the model’s heights scale with it. Camera ' +
      'positions with their accuracies, GCPs or some oblique photos fix it.',
    focalSigmaNote:
      'The focal’s ± is how far heights can move from it alone: about ± {pct, number} % of the distance from the ' +
      'cameras to the ground.',
    fitRms: 'Dense warp fit RMS',
    fitRmsValue: '{v, number, ::.000} px',
    term: '{v, number, ::.0000}',
    termP: '{v, number, ::.00000}',
    curve: 'Δr(r): {dr, number, ::.000} at the edge (r ≈ {r, number, ::.00})',
    noLens: 'No lens distortion for this camera group.',
  },
  // Quality Report ▸ Sparse (EvalSparseSection.vue).
  sparse: {
    noModel: 'No sparse model.',
    tile: {
      registered: 'Registered',
      registeredValue: '{n, number} / {total, number}',
      photos: 'photos',
      tiePoints: 'Tie points',
      count: '{n, number}',
      reprojMedian: 'Reprojection median',
      reprojP95: 'Reprojection P95',
      reprojMax: 'Reprojection max',
      observations: 'Observations',
    },
    summary: {
      title: 'Run summary',
      note: '(from the last reconstruction)',
      tracks3: '≥3-view tracks',
      p95Before: 'P95 before bundle adjustment',
      medianAfter: 'Median after bundle adjustment',
      date: 'Run date',
    },
    // Sparse Model ▸ Add to the model: one entry per extension.
    added: {
      title: 'Photos added {when}: {added, number} added{notPlaced, plural, =0 {} other {, # not placed}} ({how})',
      refined: 'then every camera refined',
      fixed: 'the model’s cameras fixed',
      notPlaced: 'not placed',
      retry: 'Try again…',
      retryNote:
        'Opens Sparse Model to add the {n, plural, one {# photo} other {# photos}} again with looser ' +
        'registration gates ({matches, number} correspondences, {px, number} px).',
    },
    tracks: {
      title: 'Track-length distribution',
      foot: 'photos per tie point (tie points seen in 2 or more photos)',
    },
    table: {
      photo: 'Photo',
      keypoints: 'Keypoints',
      pairs: 'Pairs',
      observations: 'Observations',
      rms: 'RMS',
      median: 'Median',
      max: 'Max',
      empty: 'No registered photos.',
      note: 'Click a row to open that photo with its reprojection errors drawn. Sorted worst first by RMS.',
    },
    notRegistered: 'Not registered ({n, number})',
    // Why a photo is not in the model (core/eval/imageStats.js unregisteredReasonKind).
    reason: {
      noFeatures: 'no features',
      noPairs: 'no accepted pairs',
      disconnected: 'disconnected (component {n, number})',
    },
  },
}
