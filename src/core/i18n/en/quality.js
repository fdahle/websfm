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
