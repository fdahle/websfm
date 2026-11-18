// The match list (components/modals/inspect/MatchListModal.vue) and its graph view
// (components/viewers/MatchGraph.vue): every verified pair, how it sits in the sparse
// model, and excluding a pair from reconstruction.
export default {
  title: 'Matches',
  ariaLabel: 'Match list',
  count: '{n, plural, one {# pair} other {# pairs}}',
  view: { list: 'List', graph: 'Graph' },
  empty: 'No matches yet: run Match Features first.',
  filter: {
    imageTip: 'Show only pairs containing this image (either side)',
    allImages: 'All images',
    clear: 'Clear filter',
    checkTip: 'Show only the pairs the check against the sparse model flags',
    allPairs: 'All pairs',
    flagged: 'Flagged by the model check',
    noRows: 'No pairs match the filter.',
  },
  col: {
    imageA: 'Image A',
    imageB: 'Image B',
    matches: 'Matches',
    used: 'Used',
    usedTip: 'Matches that became tie points in the sparse model',
    check: 'Model',
    checkTip: 'How the pair sits in the sparse model, checked when Sparse Model ran',
  },
  excluded: 'Excluded from reconstruction',
  verdict: {
    holds: 'may be false',
    disagrees: 'disagrees',
    overruled: 'overruled',
    agrees: 'agrees',
  },
  verdictLong: {
    holds:
      'May be a false match: it holds {photo} in place while {conflicts, number} of that photo’s ' +
      '{pairs, plural, one {# pair} other {# pairs}} disagree with the model. Exclude it and run Sparse Model again.',
    disagrees:
      'Disagrees with the model: one of its photos sits where most of its matches disagree, so this pair ' +
      'may be right and that photo misplaced.',
    overruled: 'Disagrees with the model, which did not follow it: most likely a false match, harmless to this model.',
    agrees: 'Agrees with the model: {share, number, ::percent} of its matches fit the solved cameras.',
    agreesPoints: 'Agrees with the model: {n, plural, one {# match is a tie point} other {# matches are tie points}}.',
  },
  exclude: {
    exclude: 'Exclude from reconstruction',
    excludeTip: 'Exclude this pair from reconstruction (a wrong match)',
    restore: 'Excluded: click to restore',
    restoreTip: 'Include this pair in reconstruction again',
  },
  placeholder: 'Select a pair to preview matches',
  resize: 'Drag to resize',
  graph: {
    force: 'Force',
    geographic: 'Geographic',
    modeTip: 'Force: spring layout · Geographic: camera positions',
    reset: 'Reset layout',
    resetTip: 'Reset the layout (discard the nodes you moved)',
    zoomIn: 'Zoom in',
    zoomOut: 'Zoom out',
    fit: 'Fit to view',
    empty: 'No verified pairs to graph.',
    hint:
      'Click an edge to preview it · double-click to exclude or restore it · drag a node to move it · ' +
      'drag the background to pan · scroll to zoom',
    hover: '{a} ↔ {b} · {n, plural, one {# match} other {# matches}}',
    hoverExcluded: 'excluded',
  },
}
