// Evaluate ▸ Accuracy ▸ the accuracy after each fit, against the fit before
// (components/modals/eval/AccuracyHistory.vue, core/eval/accuracySnapshot.js).
export default {
  title: 'Since the fit before',
  empty: 'No fit recorded yet. Georeference the model, and every fit after it is kept here to compare.',
  first: 'The first fit recorded; the next one is compared with it.',
  fitted: 'Fitted {when} to {method}',
  method: {
    'gcps': 'the GCPs',
    'poses': 'the camera positions',
    'dem-hold': 'a reference DEM',
    'other': 'the model',
  },
  change: 'The model changed before it: {change}.',
  controlsAdded: 'Control points added: {names}.',
  controlsRemoved: 'Control points no longer used: {names}.',
  checksAdded: 'Checkpoints added: {names}.',
  checksRemoved: 'Checkpoints no longer used: {names}.',
  metric: {
    checkpoints: 'Checkpoints ({n, number})',
    loo: 'Control points left out in turn ({n, number})',
    cameras: 'Camera positions ({n, number})',
  },
  axis: { h: 'horizontal', v: 'vertical' },
  value: '{v, number, ::.000} {unit}',
  verdict: {
    better: '▲ better',
    worse: '▼ worse',
    same: '· the same',
    changed: 'on other points: not comparable',
    new: 'new',
    gone: 'no longer measured',
  },
  noIndependent:
    'No independent check: a control point’s own error always shrinks when it is used. Mark some GCPs as ' +
    'checkpoints, or use four or more control points, so each can be left out in turn.',
  why:
    'Checkpoints never take part in the fit. With four or more control points each is predicted by a fit without ' +
    'it. The camera positions count only when the fit was made to the GCPs.',
  history: 'Every fit',
  col: {
    when: 'When',
    method: 'Fitted to',
    change: 'Model changed by',
    points: 'Control / check',
    checkpoints: 'Checkpoints H / V',
    loo: 'Left out in turn H / V',
    cameras: 'Cameras H / V',
  },
  pair: '{h, number, ::.000} / {v, number, ::.000}',
}
